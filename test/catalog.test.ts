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
import { Hono } from "hono";
import { MOUNTED_OPERATIONS, catalogRouter } from "../src/routes/catalog-router";
import { RECEIPT_KINDS } from "../src/routes/admin/receipted";

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

  it("refuses to mount a management operation where its policy would not run", () => {
    // Authorization is the entry's, so the router is what makes it
    // unskippable: a module that built a non-authorizing router for a
    // management or session operation fails as it loads, not in production.
    expect(() => catalogRouter(new Hono(), "/v1/cli").handle("getCliAccount", () => {
      throw new Error("unreachable");
    })).toThrow(/must be mounted through an authorizing router/u);
    // Public operations need no policy and may be mounted anywhere.
    expect(() => catalogRouter(new Hono(), "/v1/cli").handle("getCliCapabilities", () => {
      throw new Error("unreachable");
    })).not.toThrow();
  });

  it("mounts every receipted creation, and only those, under its receipt", () => {
    // A `receipt: true` entry documents that retries are safe, so mounting one
    // without the receipt would publish a promise the server does not keep.
    expect(() => catalogRouter(new Hono(), "/v1/admin", { authorized: true })
      .handle("createApp" as never, () => {
        throw new Error("unreachable");
      })).toThrow(/must be mounted with handleReceipted/u);
    expect(() => catalogRouter(new Hono(), "/v1/admin", { authorized: true })
      .handleReceipted("listApps" as never, () => {
        throw new Error("unreachable");
      })).toThrow(/does not honour receipts/u);
    const receipted = Object.keys(CATALOG)
      .filter((name) => (CATALOG[name as OperationName] as OperationSpec).receipt)
      .sort();
    expect(Object.keys(RECEIPT_KINDS).sort()).toEqual(receipted);
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
