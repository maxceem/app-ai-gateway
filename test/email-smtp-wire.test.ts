import { env } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendVerificationEmail } from "../src/auth/email-verification";
import { emailSender, emailSetup } from "../src/email/sender";
import { Email } from "@maxceem/worker-mailer";
import { resolveDeployment } from "../src/policy/deployment";

/*
 * The SMTP client itself, against a scripted server. `email-sender.test.ts`
 * mocks the client away to check what the gateway asks of it; this file keeps
 * the real one, because what it writes to the wire and to the logs is the part
 * a mock would hide.
 */

vi.mock("cloudflare:sockets", () => ({ connect: vi.fn() }));

const ORIGIN = "https://example.test";
const RECIPIENT = "person@example.test";

function smtpEnv(): Env {
  const values: Record<string, string> = {
    SMTP_HOST: "smtp.example.test",
    SMTP_USERNAME: "gateway@example.test",
    SMTP_PASSWORD: "app-password",
    EMAIL_FROM: "gateway@example.test",
    DEPLOYMENT_ID: "smtp-wire-test",
  };
  return new Proxy(env, {
    get: (target, property, receiver) =>
      typeof property === "string" && property in values
        ? values[property]
        : property === "EMAIL" || property === "EMAIL_SENDER" || property === "SMTP_PORT"
          ? undefined
          : Reflect.get(target, property, receiver),
  }) as Env;
}

/** A server that answers each command in turn with the next scripted reply. */
function scriptedServer(replies: string[]) {
  const writes: string[] = [];
  const queue = [...replies];
  const socket = {
    opened: Promise.resolve(),
    close: vi.fn(async () => {}),
    startTls: vi.fn(),
    readable: {
      getReader: () => ({
        read: async () => {
          const next = queue.shift();
          return next === undefined
            ? { done: true, value: undefined }
            : { done: false, value: new TextEncoder().encode(next) };
        },
        releaseLock: () => {},
      }),
    },
    writable: {
      getWriter: () => ({
        write: async (chunk: Uint8Array) => {
          writes.push(new TextDecoder().decode(chunk));
        },
        releaseLock: () => {},
      }),
    },
  };
  vi.mocked(connect).mockReturnValue(socket as never);
  return { socket, written: () => writes.join("") };
}

const GREETING_AND_SIGN_IN = [
  "220 smtp.example.test ready\r\n",
  "250-smtp.example.test\r\n250 AUTH PLAIN LOGIN\r\n",
  "235 Authentication successful\r\n",
];

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SMTP on the wire", () => {
  it("sends a verification email over TLS and closes the connection", async () => {
    const server = scriptedServer([
      ...GREETING_AND_SIGN_IN,
      "250 OK\r\n", // MAIL FROM
      "250 OK\r\n", // RCPT TO
      "354 Go ahead\r\n", // DATA
      "250 Queued\r\n", // body
      "221 Bye\r\n", // QUIT
    ]);
    const testEnv = smtpEnv();
    await sendVerificationEmail(testEnv, resolveDeployment(testEnv, ORIGIN), { id: "user-1", email: RECIPIENT }, null);

    expect(vi.mocked(connect)).toHaveBeenCalledWith(
      { hostname: "smtp.example.test", port: 465 },
      expect.objectContaining({ secureTransport: "on" }),
    );
    const wire = server.written();
    expect(wire).toContain(`RCPT TO: <${RECIPIENT}>`);
    expect(wire).toContain("Subject: Verify your email address");
    expect(wire).toContain(`${ORIGIN}/verify-email?token=`);
    expect(wire).not.toMatch(/^BCC:/im);
    expect(wire).toMatch(/QUIT\r\n$/);
    expect(server.socket.close).toHaveBeenCalledOnce();
  });

  it("logs a refused recipient without the address, and still closes the connection", async () => {
    const server = scriptedServer([
      ...GREETING_AND_SIGN_IN,
      "250 OK\r\n", // MAIL FROM
      `550 5.1.1 <${RECIPIENT}> unknown user\r\n`, // RCPT TO
      "250 Reset\r\n", // RSET
      "221 Bye\r\n", // QUIT
    ]);
    const testEnv = smtpEnv();
    await expect(
      sendVerificationEmail(testEnv, resolveDeployment(testEnv, ORIGIN), { id: "user-1", email: RECIPIENT }, null),
    ).rejects.toMatchObject({ status: 503, code: "email_unavailable" });

    expect(server.written()).toMatch(/RSET\r\nQUIT\r\n$/);
    expect(server.socket.close).toHaveBeenCalledOnce();
    expect(logged.join("\n")).toContain("verification_email_failed");
    expect(logged.join("\n")).not.toContain(RECIPIENT);
    expect(logged.join("\n")).not.toContain("app-password");
  });

  it("fails rather than hangs when the server hangs up mid-conversation", async () => {
    const server = scriptedServer(["220 smtp.example.test ready\r\n"]);
    await expect(
      emailSender(smtpEnv())!.send({
        from: { email: "gateway@example.test", name: "App AI Gateway" },
        to: RECIPIENT,
        subject: "Subject",
        text: "Text",
        html: "<p>Text</p>",
      }),
    ).rejects.toThrow(/closed the connection/);
    expect(server.socket.close).toHaveBeenCalledOnce();
  });

  it("refuses an address that would inject SMTP commands before anything is written", async () => {
    const server = scriptedServer([...GREETING_AND_SIGN_IN, "221 Bye\r\n"]);
    await expect(
      emailSender(smtpEnv())!.send({
        from: { email: "gateway@example.test", name: "App AI Gateway" },
        to: `${RECIPIENT}>\r\nRCPT TO:<other@example.test`,
        subject: "Subject",
        text: "Text",
        html: "<p>Text</p>",
      }),
    ).rejects.toThrow(/Invalid email address/);
    expect(server.written()).not.toContain("RCPT TO");
    expect(server.socket.close).toHaveBeenCalledOnce();
  });

  it("accepts exactly the sender addresses the SMTP client accepts", () => {
    const candidates = [
      "gateway@example.test",
      "first.last+tag@sub.example.co.uk",
      "<gateway@example.test>",
      "Gateway <gateway@example.test>",
      "gateway@example.test;x",
      "gate way@example.test",
      "no-at-sign",
      "a@b@c",
    ];
    for (const from of candidates) {
      const values = new Proxy(smtpEnv(), {
        get: (target, property, receiver) =>
          property === "EMAIL_FROM" ? from : Reflect.get(target, property, receiver),
      }) as Env;
      let libraryAccepts = true;
      try {
        new Email({ from, to: RECIPIENT, subject: "s", text: "t" });
      } catch {
        libraryAccepts = false;
      }
      expect(emailSetup(values).state === "ok", from).toBe(libraryAccepts);
    }
  });
});
