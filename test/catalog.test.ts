import { describe, expect, it } from "vitest";
import {
  CATALOG,
  operationPath,
  type OperationName,
  type OperationSpec,
} from "../src/contracts/catalog";
// Imported for its side effect: mounting every management route module is what
// fills `MOUNTED_OPERATIONS`, and this is the module that pulls them all in.
import "../src/routes/management";
import { MOUNTED_OPERATIONS } from "../src/routes/catalog-router";

/** The half of the catalog the management app is supposed to serve. */
const SERVED = Object.keys(CATALOG).filter((name) => {
  const path = CATALOG[name as OperationName].path;
  return path.startsWith("/v1/admin") || path.startsWith("/v1/cli");
});

describe("operation catalog", () => {
  /*
   * The document, both clients and the server mounts are all derived from the
   * catalog, so the one thing derivation cannot catch is an entry nobody
   * serves: a documented endpoint that answers 404, which the console and the
   * CLI would happily call. This is that check.
   */
  it("serves every admin and CLI operation it documents, and nothing else", () => {
    expect([...MOUNTED_OPERATIONS].sort()).toEqual([...SERVED].sort());
  });

  it("documents every path parameter it names", () => {
    for (const [name, spec] of Object.entries<OperationSpec>(CATALOG)) {
      const named = [...spec.path.matchAll(/\{(\w+)\}/gu)].map(([, key]) => key);
      expect(Object.keys(spec.params ?? {}).sort(), name).toEqual([...named].sort());
    }
  });

  it("fills a path from its template, encoding both parameters and query", () => {
    expect(operationPath("revokeAppKey", { app: "my app", key: "k/1" }))
      .toBe("/v1/admin/apps/my%20app/keys/k%2F1/revoke");
    expect(operationPath("listApps")).toBe("/v1/admin/apps");
    // Empty, null and undefined values are dropped rather than sent blank.
    expect(operationPath("listAppUsers", { app: "a" }, {
      month: "2026-08", status: undefined, query: "", limit: 50,
    })).toBe("/v1/admin/apps/a/users?month=2026-08&limit=50");
  });

  it("refuses to build a path whose parameter was not supplied", () => {
    expect(() => operationPath("getApp", {} as { app: string }))
      .toThrow(/needs a "app" path parameter/);
  });
});
