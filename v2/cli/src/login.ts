/**
 * The local end of a browser sign-in: a listener on `127.0.0.1`, on a port the
 * system picks, that the gateway's OAuth server sends the browser back to with
 * an authorization code (RFC 8252).
 *
 * The code alone is worthless: exchanging it also takes the PKCE verifier,
 * which never leaves this process. So the listener only hands over the first
 * answer whose `state` matches, tells that browser how it went, and stops.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { platform } from "node:os";

/** What the browser brought back: a code, or the server's refusal. */
export type Callback =
  | { code: string; iss: string | null }
  | { error: string; description: string | null };

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`, the redirect the CLI client registers on any port. */
  readonly redirect: string;
  /** The first answer whose `state` matched; never settles if none arrives. */
  readonly callback: Promise<Callback>;
  /** Tells the browser that delivered the answer how the sign-in went. */
  answer(connected: boolean): void;
  close(): Promise<void>;
}

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

export const CONNECTED_PAGE = page("Your terminal is signed in", "You can close this tab.");
export const FAILED_PAGE = page("The sign-in did not complete", "Return to your terminal to see what happened.");

/** Listens for the callback of one sign-in, identified by `state`. */
export async function listenLoopback(state: string): Promise<Loopback> {
  let deliver!: (value: Callback) => void;
  const callback = new Promise<Callback>((resolve) => {
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
    // Another page, or a stale tab, cannot answer for this sign-in.
    if (delivered || url.searchParams.get("state") !== state) {
      response.writeHead(400, PAGE_HEADERS).end(FAILED_PAGE);
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (!code && !error) {
      response.writeHead(400, PAGE_HEADERS).end(FAILED_PAGE);
      return;
    }
    delivered = true;
    waiting = response;
    deliver(
      code
        ? { code, iss: url.searchParams.get("iss") }
        : { error: error!, description: url.searchParams.get("error_description") },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let answered: Promise<void> = Promise.resolve();
  const loopback: Loopback = {
    redirect: `http://127.0.0.1:${port}/callback`,
    callback,
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

/** What `browserAvailable` looks at; the real values by default, replaced in tests. */
export interface BrowserSurroundings {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Whether a person is at this terminal: stdin and stderr are both terminals. */
  terminal: boolean;
}

/**
 * Whether a browser opened here would be in front of the person signing in.
 * A loopback sign-in can only finish in a browser on this machine, so over
 * SSH, without a display, or with nobody at the terminal, the device flow is
 * used instead: a link and a short code, approved in any browser.
 */
export function browserAvailable(
  { env, platform: system, terminal }: BrowserSurroundings = {
    env: process.env,
    platform: platform(),
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  },
): boolean {
  if (!terminal) return false;
  if (env["SSH_CONNECTION"] || env["SSH_TTY"]) return false;
  if (system === "linux" && !env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return false;
  return true;
}
