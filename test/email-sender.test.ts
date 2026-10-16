import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendVerificationEmail } from "../src/auth/email-verification";
import { emailSender, emailSetup, type OutgoingEmail } from "../src/email/sender";
import { resolveDeployment } from "../src/policy/deployment";
import worker from "../src/index";

const mailer = vi.hoisted(() => ({
  connect: vi.fn(),
  send: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
}));

vi.mock("@maxceem/worker-mailer", () => ({
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 },
  WorkerMailer: {
    connect: mailer.connect.mockImplementation(async () => ({ send: mailer.send, close: mailer.close })),
  },
}));

const ORIGIN = "https://example.test";
const binding = { send: vi.fn(async () => ({ messageId: "m" })) };

/** Only what a test sets: everything else about email is unset. */
function configured(values: Partial<Record<
  "EMAIL" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USERNAME" | "SMTP_PASSWORD" | "EMAIL_SENDER" | "EMAIL_FROM" | "EMAIL_REPLY_TO",
  unknown
>>): Env {
  const keys = ["EMAIL", "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "EMAIL_SENDER", "EMAIL_FROM", "EMAIL_REPLY_TO"];
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DEPLOYMENT_ID") return "sender-test-deployment";
      if (typeof property === "string" && keys.includes(property)) {
        return (values as Record<string, unknown>)[property];
      }
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

const SMTP = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USERNAME: "gateway@example.test",
  SMTP_PASSWORD: "app-password",
  EMAIL_FROM: "gateway@example.test",
};

const EMAIL: OutgoingEmail = {
  from: { email: "gateway@example.test", name: "App AI Gateway" },
  to: "person@example.test",
  subject: "Subject",
  text: "Text",
  html: "<p>Text</p>",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("emailSetup", () => {
  it("is off until something about email is configured", () => {
    expect(emailSetup(configured({}))).toEqual({ state: "off" });
    // A sender address alone sends nothing.
    expect(emailSetup(configured({ EMAIL_FROM: "a@b.test" }))).toEqual({ state: "off" });
  });

  it("uses whichever transport is configured", () => {
    expect(emailSetup(configured({ EMAIL: binding, EMAIL_FROM: "a@b.test" }))).toMatchObject({
      state: "ok",
      transport: "cloudflare",
      from: "a@b.test",
    });
    expect(emailSetup(configured(SMTP))).toMatchObject({
      state: "ok",
      transport: "smtp",
      smtp: { host: "smtp.example.test", port: 465, username: "gateway@example.test" },
    });
  });

  it("asks for EMAIL_SENDER when both are configured, and switches on it", () => {
    const both = { ...SMTP, EMAIL: binding };
    expect(emailSetup(configured(both))).toMatchObject({ state: "misconfigured", problem: expect.stringMatching(/EMAIL_SENDER/) });
    expect(emailSetup(configured({ ...both, EMAIL_SENDER: "cloudflare" }))).toMatchObject({ state: "ok", transport: "cloudflare" });
    expect(emailSetup(configured({ ...both, EMAIL_SENDER: " SMTP " }))).toMatchObject({ state: "ok", transport: "smtp" });
  });

  it("calls an incomplete or contradictory setup misconfigured, naming the setting and never a value", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...SMTP, EMAIL_SENDER: "ses" }, /EMAIL_SENDER must be/],
      [{ ...SMTP, EMAIL_SENDER: "cloudflare" }, /no EMAIL binding/],
      [{ EMAIL: binding, EMAIL_SENDER: "smtp", EMAIL_FROM: "a@b.test" }, /SMTP_HOST is not set/],
      // Any SMTP setting means SMTP is intended: a missing or blank host is a
      // mistake to report, never a deployment that sends no email.
      [{ ...SMTP, SMTP_HOST: undefined }, /SMTP_HOST is not set/],
      [{ ...SMTP, SMTP_HOST: "  " }, /SMTP_HOST is not set/],
      [{ SMTP_PASSWORD: "app-password", EMAIL_FROM: "a@b.test" }, /SMTP_HOST is not set/],
      [{ SMTP_PORT: "587" }, /SMTP_HOST is not set/],
      [{ EMAIL: binding, SMTP_USERNAME: "x", EMAIL_FROM: "a@b.test" }, /set EMAIL_SENDER/],
      [{ ...SMTP, SMTP_PORT: "25" }, /SMTP_PORT 25/],
      [{ ...SMTP, SMTP_PORT: "smtp" }, /SMTP_PORT must be/],
      [{ ...SMTP, SMTP_USERNAME: " " }, /SMTP_USERNAME/],
      [{ ...SMTP, SMTP_PASSWORD: "" }, /SMTP_PASSWORD/],
      [{ ...SMTP, EMAIL_FROM: "not an address" }, /EMAIL_FROM/],
      // Display names and brackets are the library's to add: it refuses them here.
      [{ ...SMTP, EMAIL_FROM: "<gateway@example.test>" }, /EMAIL_FROM/],
      [{ ...SMTP, EMAIL_FROM: "Gateway <gateway@example.test>" }, /EMAIL_FROM/],
      [{ ...SMTP, EMAIL_FROM: "gateway@example.test;x" }, /EMAIL_FROM/],
      [{ ...SMTP, EMAIL_REPLY_TO: "Support <support@example.test>" }, /EMAIL_REPLY_TO/],
      [{ EMAIL_SENDER: "smtp" }, /SMTP_HOST is not set/],
    ];
    for (const [values, problem] of cases) {
      const setup = emailSetup(configured(values));
      expect(setup, JSON.stringify(values)).toMatchObject({ state: "misconfigured", problem: expect.stringMatching(problem) });
      expect(JSON.stringify(setup)).not.toContain("app-password");
    }
  });

  it("keeps verification on for a setup that cannot send yet", () => {
    expect(resolveDeployment(configured({ EMAIL: binding })).emailVerification).toBe("required");
    expect(resolveDeployment(configured({ ...SMTP, SMTP_PASSWORD: "" })).emailVerification).toBe("required");
    expect(resolveDeployment(configured({ ...SMTP, SMTP_HOST: "" })).emailVerification).toBe("required");
    expect(resolveDeployment(configured({})).emailVerification).toBe("off");
  });
});

describe("replies", () => {
  it("go to EMAIL_REPLY_TO through either transport, and to the sender without it", async () => {
    expect(emailSetup(configured(SMTP))).toMatchObject({ state: "ok", replyTo: null });
    const replying = { ...SMTP, EMAIL_REPLY_TO: " support@example.test " };
    expect(emailSetup(configured(replying))).toMatchObject({ state: "ok", replyTo: "support@example.test" });

    await emailSender(configured(replying))!.send({ ...EMAIL, replyTo: "support@example.test" });
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ reply: "support@example.test" }));

    const cloudflare = { EMAIL: binding, EMAIL_FROM: "gateway@example.test" };
    await emailSender(configured(cloudflare))!.send({ ...EMAIL, replyTo: "support@example.test" });
    expect(binding.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "support@example.test" }));
    await emailSender(configured(cloudflare))!.send(EMAIL);
    expect(binding.send).toHaveBeenLastCalledWith(expect.not.objectContaining({ replyTo: expect.anything() }));
  });
});

describe("the SMTP transport", () => {
  it("connects with TLS on 465, signs in, sends, closes, and switches the library's logging off", async () => {
    await emailSender(configured(SMTP))!.send(EMAIL);
    expect(mailer.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      startTls: false,
      credentials: { username: "gateway@example.test", password: "app-password" },
      logLevel: 4,
    }));
    expect(mailer.send).toHaveBeenCalledWith({
      from: { name: "App AI Gateway", email: "gateway@example.test" },
      to: "person@example.test",
      subject: "Subject",
      text: "Text",
      html: "<p>Text</p>",
    });
    expect(mailer.close).toHaveBeenCalledOnce();
  });

  it("upgrades with STARTTLS on any other port", async () => {
    await emailSender(configured({ ...SMTP, SMTP_PORT: "587" }))!.send(EMAIL);
    expect(mailer.connect).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false, startTls: true }));
  });

  it("closes the connection when the server refuses the email", async () => {
    mailer.send.mockRejectedValueOnce(new Error("550 5.1.1 <person@example.test> unknown user"));
    await expect(emailSender(configured(SMTP))!.send(EMAIL)).rejects.toThrow(/550/);
    expect(mailer.close).toHaveBeenCalledOnce();
  });

  it("sends a verification link, and logs an SMTP refusal without the address it quotes", async () => {
    const testEnv = configured(SMTP);
    const deployment = resolveDeployment(testEnv, ORIGIN);
    await sendVerificationEmail(testEnv, deployment, { id: "user-1", email: "person@example.test" }, null);
    const sent = (mailer.send.mock.calls as unknown as Array<[{ to: string; text: string }]>)[0]![0];
    expect(sent.to).toBe("person@example.test");
    expect(sent.text).toContain(`${ORIGIN}/verify-email?token=`);

    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mailer.send.mockRejectedValueOnce(new Error("550 5.1.1 <person@example.test> unknown user"));
    await expect(sendVerificationEmail(testEnv, deployment, { id: "user-1", email: "person@example.test" }, null))
      .rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    const output = [...logged.mock.calls, ...errors.mock.calls].flat().join(" ");
    expect(output).toContain("verification_email_failed");
    expect(output).toContain("smtp");
    expect(output).not.toContain("person@example.test");
  });

  it("reports a setup that cannot send in health, and refuses to send with it", async () => {
    const testEnv = configured({ ...SMTP, EMAIL: binding });
    const health = await worker.request(`${ORIGIN}/v1/healthz`, {}, testEnv);
    await expect(health.json()).resolves.toMatchObject({ email: "misconfigured" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(sendVerificationEmail(
      testEnv,
      resolveDeployment(testEnv, ORIGIN),
      { id: "user-1", email: "person@example.test" },
      null,
    )).rejects.toMatchObject({ status: 503, code: "email_unavailable" });
    expect(mailer.connect).not.toHaveBeenCalled();
    expect(binding.send).not.toHaveBeenCalled();
  });
});
