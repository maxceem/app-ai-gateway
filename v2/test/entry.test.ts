/**
 * The Worker's entry: what it exports, that every documented operation is
 * served, and how a refusal or a failure is answered and logged.
 *
 * Ported from v1's `entry-exports.test.ts`, `catalog.test.ts`,
 * `gateway-errors.test.ts` and `routing.test.ts`. The JSON 404 for an unknown
 * path and the health check are in `worker.test.ts`.
 */
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as entry from "../src/index.ts";
import { CATALOG, type OperationName } from "../src/contracts/catalog.ts";
import { CLIENT_CATALOG } from "../src/contracts/client-catalog.ts";
import type { OperationSpec } from "../src/contracts/operation.ts";
import { clearCaches, loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS, seedApp, seedManagementKey } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
/** What the entry answers for a path nothing is mounted at. */
const UNSERVED_MESSAGE = "Nothing is served at this path.";

interface Line {
  level: string;
  message: string;
  [field: string]: unknown;
}

/** Every console call as text, and the structured lines among them. */
function captureLogs(): { lines: Line[]; output: string[] } {
  const lines: Line[] = [];
  const output: string[] = [];
  const collect = (...values: unknown[]) => {
    output.push(...values.map((value) => (typeof value === "string" ? value : JSON.stringify(value) ?? String(value))));
    if (typeof values[0] !== "string") return;
    try {
      lines.push(JSON.parse(values[0]) as Line);
    } catch {
      // Not one of ours; still in `output`.
    }
  };
  for (const level of ["debug", "info", "log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(collect);
  }
  return { lines, output };
}

beforeEach(() => clearCaches());
afterEach(() => vi.restoreAllMocks());

describe("the Worker entry module", () => {
  /**
   * workerd reads every named export of the entry module as a Durable Object
   * or entrypoint class, and the default export as the handler, and refuses
   * to start the Worker over an export of any other type. The test pool does
   * not load the entry that way, so a stray export would pass every other
   * test and fail only once deployed.
   */
  it("exports only the handler and classes", () => {
    const { default: handler, ...named } = entry;
    expect(Object.keys(named).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(named)) {
      expect(typeof value, name).toBe("function");
    }
    expect(typeof handler).toBe("object");
    expect(typeof handler.fetch).toBe("function");
    expect(typeof handler.scheduled).toBe("function");
  });
});

/** The console's own origin in the test deployment (`vitest.config.ts`). */
const CONSOLE = "https://console.gateway.test";

/**
 * A request for one documented operation, its path parameters filled with a
 * stand-in. The console's page steps are only served on the console's own
 * origin, from its own page, so they are asked for there.
 */
function requestFor(spec: Pick<OperationSpec, "method" | "path">, managementKey: string): Request {
  const path = spec.path.replace(/\{(\w+)\}/gu, "catalog-mount-check");
  const body = spec.method === "GET" || spec.method === "DELETE" ? undefined : "{}";
  const consoleStep = path.startsWith("/v2/console/") && path !== "/v2/console/capabilities";
  const headers: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
  if (consoleStep) headers.origin = CONSOLE;
  // Past the credential check, so a missing handler cannot hide behind a 401.
  if (path.startsWith("/v2/admin/") || path.startsWith("/v2/cli/")) headers.authorization = `Bearer ${managementKey}`;
  return new Request(`${consoleStep ? CONSOLE : ORIGIN}${path}`, {
    method: spec.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * Whether the entry answered as if nothing were mounted there. Any other
 * answer, a refusal included, means a handler was reached.
 */
async function unserved(response: Response): Promise<boolean> {
  if (response.status !== 404 && response.status !== 405) return false;
  const text = await response.text();
  if (response.status === 405) return true;
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message === UNSERVED_MESSAGE;
  } catch {
    // A 404 from the console's static files: a page, not an operation.
    return true;
  }
}

describe("the operation catalogs", () => {
  /*
   * The document, both clients and the server mounts all come from the
   * catalog, so the one thing that cannot catch is an entry nobody serves: a
   * documented operation that answers 404, which the console and the CLI
   * would still call.
   */
  // The management code loads lazily; loading it once here keeps that cost out of the test.
  beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

  it("serve every operation they document", async () => {
    captureLogs();
    const key = await seedManagementKey();
    const missing: string[] = [];
    let unauthenticated = 0;
    for (const [name, spec] of Object.entries<OperationSpec>(CATALOG)) {
      const response = await exports.default.fetch(requestFor(spec, key));
      if (response.status === 401 && (spec.path.startsWith("/v2/admin/") || spec.path.startsWith("/v2/cli/"))) unauthenticated += 1;
      if (await unserved(response)) missing.push(`${name} ${spec.method} ${spec.path}`);
    }
    expect(missing).toEqual([]);
    // The key got every management call past the credential check.
    expect(unauthenticated).toBe(0);
  });

  it("give each operation a route of its own", () => {
    const routes = Object.values<OperationSpec>(CATALOG).map((spec) => `${spec.method} ${spec.path}`);
    expect(new Set(routes).size).toBe(routes.length);
    // The client operations are part of the one catalog everything derives from.
    for (const name of Object.keys(CLIENT_CATALOG)) expect(Object.keys(CATALOG)).toContain(name);
  });

  it("documents every path parameter they name", () => {
    for (const [name, spec] of Object.entries<OperationSpec>(CATALOG)) {
      const named = [...spec.path.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]!);
      expect(Object.keys(spec.params ?? {}).sort(), name as OperationName).toEqual(named.sort());
    }
  });
});

function tokenExchange(appId: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${ORIGIN}/v2/apps/${appId}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ issuer_token: "planted-issuer-token", key_id: "k", assertion: "a", challenge: "c" }),
  });
}

describe("refusal logging", () => {
  it("logs a refusal once, at warn, with the route and the app version, never the request or an unregistered path segment", async () => {
    const { lines, output } = captureLogs();

    const response = await tokenExchange("never-registered-segment", { "x-app-version": "4.2.0" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "app_not_found" } });
    const refusals = lines.filter((line) => line.message === "gateway_error");
    expect(refusals).toEqual([
      expect.objectContaining({
        level: "warn",
        code: "app_not_found",
        status: 404,
        method: "POST",
        path: "/v2/apps/:app/auth/token",
        appVersion: "4.2.0",
      }),
    ]);
    // The segment names no registered app: it is the caller's own text.
    expect(refusals[0]).not.toHaveProperty("app");
    expect(output.join("\n")).not.toContain("never-registered-segment");
    expect(output.join("\n")).not.toContain("planted-issuer-token");
    expect(lines.some((line) => line.level === "error")).toBe(false);
  });

  it("names the app a refusal was about once the handler loaded it", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const { lines } = captureLogs();

    const response = await tokenExchange(appId);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const line = lines.find((entry) => entry.message === "gateway_error");
    expect(line).toMatchObject({ app: appId });
  });

  it("leaves out an app version that is not shaped like one", async () => {
    const { lines } = captureLogs();

    await tokenExchange("never-registered-version", { "x-app-version": `release-${"x".repeat(100)}` });

    const line = lines.find((entry) => entry.message === "gateway_error");
    expect(line).toMatchObject({ code: "app_not_found" });
    expect(line).not.toHaveProperty("appVersion");
  });

  it("answers an unexpected failure as internal_error, logging its class and nothing it carries", async () => {
    const appId = await seedApp({ type: "api_key" });
    // Past every check on the way in: a stored config that no longer reads.
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind("sk-leaked", appId).run();
    clearCaches();
    const { lines, output } = captureLogs();

    const response = await tokenExchange(appId);

    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(["internal_error", "service_unavailable"]).toContain(body.error.code);
    expect(lines.some((line) => line.message === "gateway_error")).toBe(false);
    expect(lines.filter((line) => line.level === "error").length).toBeGreaterThan(0);
    expect(output.join("\n")).not.toContain("sk-leaked");
  });
});
