import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("the v2 Worker", () => {
  it("answers the health check", async () => {
    const response = await exports.default.fetch("https://gateway.test/v2/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway", api: "v2" });
  });

  it.each(["/v2", "/v2/", "/v2/apps/a/nothing", "/v1/healthz", "/"])(
    "answers %s with a JSON 404",
    async (path) => {
      const response = await exports.default.fetch(`https://gateway.test${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    },
  );
});
