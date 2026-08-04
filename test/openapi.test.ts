import { describe, expect, it } from "vitest";
import { createOpenAPIDocument } from "../src/contracts/openapi";
import { AppWriteSchema } from "../src/contracts/schemas";
import developmentConfig from "../config/calorie-tracker.development.json";
import productionConfig from "../config/calorie-tracker.production.json";

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
    expect(document.paths).toHaveProperty("/v1/admin/apps");
    expect(document.paths).toHaveProperty("/v1/admin/apps/{app}/usage");
  });

  it("accepts the checked-in application examples", () => {
    for (const [name, value] of [
      ["development", developmentConfig],
      ["production", productionConfig],
    ] as const) {
      expect(AppWriteSchema.safeParse(value), name).toMatchObject({ success: true });
    }
  });
});
