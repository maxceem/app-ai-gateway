import { describe, expect, it } from "vitest";
import { createOpenAPIDocument } from "../src/contracts/openapi";
import { AppWriteSchema } from "../src/contracts/schemas";
import { appleConfig, serverConfig } from "./helpers";

describe("generated OpenAPI contract", () => {
  it("has unique operation IDs and covers every public API family", () => {
    const document = createOpenAPIDocument();
    const operations = Object.values(document.paths ?? {}).flatMap((path) =>
      Object.values(path ?? {}).filter(
        (operation): operation is { operationId?: string } =>
          typeof operation === "object" && operation !== null && "operationId" in operation,
      ),
    );
    const ids = operations.map((operation) => operation.operationId);

    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.paths).toHaveProperty("/v1/healthz");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/auth/token");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/proxy/{provider}/{path}");
    expect(document.paths).toHaveProperty("/v1/apps/{app}/endpoints/{slug}");
    expect(document.paths).toHaveProperty("/v1/admin/apps");
    expect(document.paths).toHaveProperty("/v1/admin/apps/{app}/usage");
    expect(document.paths).toHaveProperty("/v1/auth/sign-up/email");
    expect(document.paths).toHaveProperty("/v1/auth/sign-in/email");
    expect(document.paths).toHaveProperty("/v1/admin/keys");
    expect(document.paths).toHaveProperty("/v1/console/capabilities");
    expect(document.paths).toHaveProperty("/v1/admin/billing/status");
    expect(document.paths).toHaveProperty("/v1/admin/billing/checkout");
    expect(document.components?.securitySchemes).toHaveProperty("OperatorSession");
    expect(document.components?.securitySchemes).toHaveProperty("ManagementBearer");
  });

  it("accepts representative server and mobile application examples", () => {
    for (const [name, config] of [
      ["server", serverConfig()],
      ["mobile", appleConfig({ jwks_url: "https://issuer.example/.well-known/jwks.json" })],
    ] as const) {
      expect(AppWriteSchema.safeParse({ name: `${name} example`, config }), name).toMatchObject({
        success: true,
      });
    }
  });
});
