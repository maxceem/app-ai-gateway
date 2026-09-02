import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("AI Gateway", () => {
  it("serves the health check", async () => {
    const response = await exports.default.fetch("https://example.test/v1/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "ai-gateway",
      vault: "ok",
    });
  });
});
