import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, platform, release } from "node:os";
import { CliProofSchema } from "../../src/contracts/cli.ts";

/**
 * The local end of a browser login: a listener on `127.0.0.1`, on a port the
 * system picks, that the approval page sends the browser back to with the
 * login's one-time redeem code.
 *
 * The code alone is worthless — redeeming it also takes the operation's token,
 * which never leaves this process — so the listener only has to hand the first
 * well-formed code over, answer that browser once the terminal knows how the
 * redemption went, and stop.
 */
export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`, as `openCliLogin` requires it. */
  readonly redirect: string;
  /** The redeem code the browser delivered; never settles if none arrives. */
  readonly code: Promise<string>;
  /** Answers the browser that delivered the code, if one did. */
  answer(connected: boolean): void;
  close(): Promise<void>;
}

/** The query parameter the approval page puts the redeem code in. */
export const REDEEM_CODE_PARAMETER = "code";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  connection: "close",
};

function page(title: string, text: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
    `<h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body></html>`
  );
}

export const CONNECTED_PAGE = page(
  "Your terminal is connected",
  "The CLI has its key. You can close this tab.",
);
export const FAILED_PAGE = page(
  "The login did not complete",
  "Return to your terminal to see what happened.",
);

export async function listenLoopback(): Promise<Loopback> {
  let deliver!: (code: string) => void;
  const code = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  let waiting: ServerResponse | null = null;
  let delivered = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, PAGE_HEADERS).end(page("Not found", "Nothing is served here."));
      return;
    }
    const value = url.searchParams.get(REDEEM_CODE_PARAMETER) ?? "";
    if (delivered || !CliProofSchema.safeParse(value).success) {
      response.writeHead(400, PAGE_HEADERS).end(FAILED_PAGE);
      return;
    }
    delivered = true;
    waiting = response;
    deliver(value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  /** Settles once the answer to the browser has been handed to its socket. */
  let answered: Promise<void> = Promise.resolve();
  const loopback: Loopback = {
    redirect: `http://127.0.0.1:${port}/callback`,
    code,
    answer(connected) {
      const response = waiting;
      if (!response) return;
      waiting = null;
      answered = new Promise<void>((resolve) => {
        response.once("finish", resolve);
        response.once("close", resolve);
      });
      response.writeHead(200, PAGE_HEADERS).end(connected ? CONNECTED_PAGE : FAILED_PAGE);
    },
    async close() {
      loopback.answer(false);
      await answered;
      await new Promise<void>((resolve) => {
        // A browser holding an idle connection open must not keep the command
        // alive; one still reading its page gets a moment to finish.
        const force = setTimeout(() => server.closeAllConnections(), 1000);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
  return loopback;
}

/** What a login tells the approval page about this CLI; shown there, never trusted. */
export function clientDescription(): { label: string; os: string } {
  return {
    label: `CLI on ${hostname() || "this computer"}`.slice(0, 200),
    os: `${platform()} ${release()}`.trim().slice(0, 64),
  };
}

/** What `browserAvailable` looks at; the real values by default, replaced in tests. */
export interface BrowserSurroundings {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Whether a person is at this terminal: stdin and stderr are both terminals. */
  terminal: boolean;
}

/**
 * Whether a browser opened on this machine would be in front of the person
 * approving the login.
 *
 * Decided before a login is opened, because a login that registers a loopback
 * redirect can only be finished by a browser on this machine: approved from
 * any other device, the page sends that device to its own `127.0.0.1`, and the
 * key it minted is never collected. Over SSH, on a Linux box with no display,
 * or with nobody at the terminal, the login is polled for instead.
 */
export function browserAvailable({
  env,
  platform: system,
  terminal,
}: BrowserSurroundings = {
  env: process.env,
  platform: platform(),
  terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
}): boolean {
  if (!terminal) return false;
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return false;
  if (system === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return true;
}
