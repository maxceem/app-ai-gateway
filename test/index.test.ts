import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import gateway from "../src/index";
import { clearIsolateCaches } from "./helpers";

describe("App AI Gateway", () => {
  it("serves the health check", async () => {
    const response = await exports.default.fetch("https://example.test/v1/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "app-ai-gateway",
      vault: "ok",
      buildId: "development",
      ready: true,
      backendContract: 1,
      realtimeReleaseId: null,
    });
  });

  it("probes again after a failed health check instead of repeating the failure", async () => {
    clearIsolateCaches();
    let failing = true;
    const flaky = { ...env, DB: new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => { if (failing) throw new Error("Simulated D1 outage"); return target.prepare(sql); };
      return Reflect.get(target, property);
    } }) } as Env;
    const probe = () => gateway.fetch(new Request("https://example.test/v1/healthz"), flaky, createExecutionContext());
    expect((await probe()).status).toBe(500);
    failing = false;
    expect((await probe()).status).toBe(200);
  });
});
