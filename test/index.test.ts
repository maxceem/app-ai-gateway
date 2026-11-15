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
      email: "off",
      buildId: "development",
      ready: true,
      backendContract: 1,
      realtimeReleaseId: null,
    });
  });

  it("probes again a second after a failed health check, not five", async () => {
    clearIsolateCaches();
    let failing = true;
    const flaky = { ...env, DB: new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => { if (failing) throw new Error("Simulated D1 outage"); return target.prepare(sql); };
      return Reflect.get(target, property);
    } }) } as Env;
    const probe = async () => {
      const response = await gateway.fetch(new Request("https://example.test/v1/healthz"), flaky, createExecutionContext());
      // Up but not ready, never an error: monitors read this route as "is it up".
      expect(response.status).toBe(200);
      return ((await response.json()) as { ready: boolean }).ready;
    };
    expect(await probe()).toBe(false);
    failing = false;
    // Within the second the failure is answered again, without a probe.
    expect(await probe()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await probe()).toBe(true);
  });
});
