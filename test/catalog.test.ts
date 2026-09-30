import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  operationPath,
  type OperationSpec,
  type SecurityKind,
} from "../src/contracts/catalog";
// Imported for its side effect: mounting every management route module is what
// fills `MOUNTED_OPERATIONS`, and this is the module that pulls them all in.
import "../src/routes/management";
import { Hono } from "hono";
import { MOUNTED_OPERATIONS, catalogRouter } from "../src/routes/catalog-router";
import { GatewayError } from "../src/core/errors";
import { runOperation, type OperationCaller } from "../src/management/executor";
import { OPERATION_HANDLERS } from "../src/management/handlers";
import { resolveDeployment } from "../src/policy/deployment";

/** The credentials only an operation mounted through a catalog router is reached with. */
const CATALOG_MOUNTED_SECURITY: ReadonlySet<SecurityKind> = new Set(["management", "session", "cliPoll"]);
/** Documented, but served by Better Auth's own handler rather than a catalog router. */
const BETTER_AUTH_TAG = "Console authentication";

/**
 * The half of the catalog the management app is supposed to serve, picked by
 * the credential that reaches it rather than by where its path lives, so a new
 * surface cannot fall out of this check by choosing a new prefix: everything a
 * management key, a browser session or a CLI poll reaches, and the public
 * steps of a CLI handoff.
 * Those public handoff steps are selected by their `CLI` tag.
 */
const SERVED = Object.entries<OperationSpec>(CATALOG)
  .filter(([, spec]) =>
    !spec.tags.includes(BETTER_AUTH_TAG)
    && (CATALOG_MOUNTED_SECURITY.has(spec.security)
      || (spec.security === "public" && spec.tags.includes("CLI"))))
  .map(([name]) => name);

describe("operation catalog", () => {
  /*
   * The document, both clients and the server mounts are all derived from the
   * catalog, so the one thing derivation cannot catch is an entry nobody
   * serves: a documented endpoint that answers 404, which the console and the
   * CLI would happily call. This is that check.
   */
  it("serves every admin and CLI operation it documents, and nothing else", () => {
    expect([...MOUNTED_OPERATIONS].sort()).toEqual([...SERVED].sort());
    // Whatever a credential says, nothing under the two management prefixes is
    // left out of the set above.
    for (const [name, spec] of Object.entries<OperationSpec>(CATALOG)) {
      if (spec.path.startsWith("/v1/admin") || spec.path.startsWith("/v1/cli")) {
        expect(SERVED, name).toContain(name);
      }
    }
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

  it("mounts every registered handler under the operation it is keyed by", () => {
    for (const name of Object.keys(OPERATION_HANDLERS)) {
      expect(Object.keys(CATALOG), name).toContain(name);
      expect(MOUNTED_OPERATIONS.has(name as keyof typeof CATALOG), name).toBe(true);
    }
  });

  it("runs a registered operation for any caller its entry admits, whatever the transport", async () => {
    const deploymentEnv = { ...env, DEPLOYMENT_ID: "catalog-test-deployment" } as Env;
    const caller: OperationCaller = {
      scope: {
        env: deploymentEnv,
        deployment: resolveDeployment(deploymentEnv, "https://example.test/"),
        billingCache: new Map(),
      },
    };
    const request = { params: {}, query: {} };
    // A public operation needs no one to have authenticated.
    const capabilities = await runOperation(
      "getCliCapabilities",
      caller,
      request,
      OPERATION_HANDLERS.getCliCapabilities,
    );
    expect(capabilities.protocolVersion).toBe(1);
    // A guarded one refuses a caller no transport authenticated, before its
    // handler is reached.
    const refused = await runOperation("getCliAccount", caller, request, () => {
      throw new Error("unreachable");
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GatewayError);
    expect(refused).toMatchObject({ status: 401, code: "auth_required" });
  });

  it("types a call's path parameters by the operation it names", () => {
    // Never run: this is checked by `pnpm run check`, where the directive
    // fails if the call below ever compiles.
    const typeOnly = (caller: OperationCaller) => [
      runOperation("revokeAppKey", caller, { params: { app: "a", key: "k" }, query: {} }, OPERATION_HANDLERS.revokeAppKey),
      // @ts-expect-error `revokeAppKey` names `{key}` in its path, so params without it do not compile.
      runOperation("revokeAppKey", caller, { params: { app: "a" }, query: {} }, OPERATION_HANDLERS.revokeAppKey),
    ];
    expect(typeof typeOnly).toBe("function");
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
