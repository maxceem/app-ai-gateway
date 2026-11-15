import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { clearIsolateCaches, seedServerApp } from "./helpers";

/**
 * The `server-timing` header a served request answers with: which steps it
 * names, in which order, and what a step the request never reached reports.
 *
 * Clients may parse it, so the entries keep their names and their order. A
 * step a request was refused in reports how long the refusal took, and one it
 * never reached is left out, so it is not mistaken for one that took no time.
 */

/** Long enough that no other step of a test request could account for it. */
const SLOW_MS = 100;

const ORIGIN = "https://example.test";
const ENTRIES = ["auth", "prepare", "limiter", "provider_ttfb"];
const contexts: ExecutionContext[] = [];

async function send(path: string, key: string, body: unknown): Promise<Response> {
  const executionCtx = createExecutionContext();
  contexts.push(executionCtx);
  const response = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-end-user-id": "timing-user",
      },
      body: JSON.stringify(body),
    }),
    env,
    executionCtx,
  );
  return new Response(await response.arrayBuffer(), response);
}

const proxy = (appId: string, key: string, path = "openai/v1/responses") =>
  send(`/v1/apps/${appId}/proxy/${path}`, key, { model: "gpt-5.6-sol", input: "hello" });

/** Every entry of the header, by name, in the order it was sent. */
function serverTimings(response: Response): Array<[string, number]> {
  const header = response.headers.get("server-timing");
  expect(header).not.toBeNull();
  return header!.split(", ").map((entry) => {
    const match = /^([a-z_]+);dur=(\d+\.\d)$/u.exec(entry);
    expect(match, entry).not.toBeNull();
    return [match![1]!, Number(match![2])];
  });
}

function expectEntries(response: Response, names = ENTRIES): Record<string, number> {
  const entries = serverTimings(response);
  expect(entries.map(([name]) => name)).toEqual(names);
  for (const [, duration] of entries) {
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  }
  return Object.fromEntries(entries);
}

/**
 * Makes unlocking a stored provider key slow. The vault decrypts only while the
 * plan is prepared, so the delay belongs to `prepare` and to nothing else.
 */
function slowDecrypt(): void {
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return decrypt(...args);
  });
}

/**
 * Makes hashing a presented API key slow. Only authentication hashes one, so
 * the delay belongs to `auth` and to nothing else.
 */
function slowKeyHash(): void {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return digest(...args);
  });
}

function mockUpstream(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
  );
}

beforeEach(() => {
  clearIsolateCaches();
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
  vi.restoreAllMocks();
});

describe("server-timing", () => {
  it("names every step of a served proxy request, prepare between auth and limiter", async () => {
    const key = await seedServerApp("timing-proxy");
    mockUpstream();
    slowDecrypt();

    const response = await proxy("timing-proxy", key);

    expect(response.status).toBe(200);
    const timings = expectEntries(response);
    expect(timings.prepare).toBeGreaterThanOrEqual(SLOW_MS * 0.9);
    expect(timings.limiter).toBeLessThan(SLOW_MS * 0.9);
    // The pattern readers written before `prepare` existed match on.
    expect(response.headers.get("server-timing")).toMatch(/auth.*limiter.*provider_ttfb/u);
  });

  it("names every step of a served custom endpoint", async () => {
    const key = await seedServerApp("timing-endpoint", {
      endpoints: { chat: { api_style: "responses", provider: "openai", model: "gpt-5.6-luna" } },
    });
    mockUpstream();

    const response = await send("/v1/apps/timing-endpoint/endpoints/chat", key, { input: "hello" });

    expect(response.status).toBe(200);
    expectEntries(response);
  });

  it("leaves the provider out of a request refused at admission", async () => {
    const key = await seedServerApp("timing-admission", { limits: { rpm: 1 } });
    mockUpstream();

    expect((await proxy("timing-admission", key)).status).toBe(200);
    const refused = await proxy("timing-admission", key);

    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "app_rate_limited" } });
    expectEntries(refused, ["auth", "prepare", "limiter"]);
  });

  it("reports how long prepare took to refuse a request, and nothing after it", async () => {
    const key = await seedServerApp("timing-prepare-refused");
    slowDecrypt();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // The provider key is unlocked before the model is checked against it.
    const refused = await send("/v1/apps/timing-prepare-refused/proxy/openai/v1/responses", key, {
      model: "not-allowed",
      input: "hello",
    });

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    const timings = expectEntries(refused, ["auth", "prepare"]);
    expect(timings.prepare).toBeGreaterThanOrEqual(SLOW_MS * 0.9);
  });

  it("reports how long a refused credential took, and nothing after it", async () => {
    await seedServerApp("timing-auth-refused");
    slowKeyHash();

    const refused = await proxy("timing-auth-refused", `agw_${"Z".repeat(48)}`);

    expect(refused.status).toBe(401);
    const timings = expectEntries(refused, ["auth"]);
    expect(timings.auth).toBeGreaterThanOrEqual(SLOW_MS * 0.9);
  });
});
