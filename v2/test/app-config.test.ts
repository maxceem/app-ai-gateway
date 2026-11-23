/**
 * The app configuration grammar (`src/contracts/app-config.ts`): its
 * defaults and round trip, unknown keys, the issuer settings and the App
 * Attest settings.
 *
 * Ported from v1's `config.test.ts` for the parts v2 kept. The routing,
 * preset, limit and field-setting grammar is in `limits.test.ts`,
 * `presets.test.ts` and `field-settings.test.ts`; saving through the API is in
 * `management.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  ConfigError,
  parseAppConfig,
  parseAuthentication,
  parseServedAppConfig,
  providerKeyHeaderProblem,
} from "../src/contracts/app-config.ts";

const ISSUER = {
  jwks_url: "https://issuer.example.test/.well-known/jwks.json",
  issuer: "https://issuer.example.test",
  audience: "my-project",
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 3600,
};

const ATTEST = { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" };

function attestApp(appAttest: Record<string, unknown> = {}, endUser: Record<string, unknown> = { source: "app_install" }) {
  return { authentication: { type: "apple_app_attest", end_user: endUser, app_attest: { ...ATTEST, ...appAttest } } };
}

function serverApp(endUser: Record<string, unknown> = { source: "none" }) {
  return { authentication: { type: "api_key", end_user: endUser } };
}

function problem(config: unknown): string {
  try {
    parseAppConfig(config);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("defaults and round trip", () => {
  it("fills the defaults of a minimal App Attest app: production only, every request signed", () => {
    const config = parseAppConfig(attestApp());
    expect(config.authentication).toEqual({
      type: "apple_app_attest",
      end_user: { source: "app_install" },
      app_attest: { ...ATTEST, environments: ["production"], verify_on: "every_request" },
    });
    expect(config.routing).toBeDefined();
    expect(config.limits).toBeDefined();
    expect(config.presets).toBeUndefined();
    expect(config.conversations).toBeUndefined();
  });

  it("reads back what it wrote, unchanged", () => {
    for (const input of [
      attestApp({ environments: ["production", "development"], verify_on: "token_exchange" }),
      attestApp({}, { source: "issuer", issuer: ISSUER }),
      serverApp({ source: "header", header: "x-player-id" }),
      serverApp({ source: "issuer", issuer: { ...ISSUER, token_header: "x-firebase-token" } }),
      serverApp(),
    ]) {
      const once = parseAppConfig(input);
      expect(parseAppConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
    }
  });

  it("requires a server app to say whether it has end users", () => {
    expect(problem({ authentication: { type: "api_key" } })).toContain("authentication.end_user");
  });

  it("refuses an unknown app type", () => {
    expect(() => parseAppConfig({ authentication: { type: "magic" } })).toThrow(ConfigError);
  });
});

describe("unknown keys", () => {
  it("refuses an unknown key when saving, wherever it is", () => {
    expect(problem({ ...serverApp(), surprise: true })).toBe(": Unrecognized key: \"surprise\"");
    expect(problem({ authentication: { type: "api_key", end_user: { source: "none" }, extra: 1 } })).toContain("authentication");
    expect(problem(attestApp({ extra: 1 }))).toContain("authentication.app_attest");
  });

  it("drops an unknown key when serving, and names it, so a newer release's setting never breaks an app after a rollback", () => {
    const { config, ignoredKeys } = parseServedAppConfig({
      ...attestApp({ future_setting: "x" }),
      routing: { providers: {}, later: true },
      something_new: { a: 1 },
    });
    expect(config.authentication.type).toBe("apple_app_attest");
    expect(ignoredKeys.sort()).toEqual(["authentication.app_attest.future_setting", "routing.later", "something_new"]);
  });

  it("still refuses a served configuration that is wrong in another way", () => {
    expect(() => parseServedAppConfig(attestApp({ team_id: "short", surplus: 1 }))).toThrow(ConfigError);
  });
});

describe("issuer settings", () => {
  const withIssuer = (issuer: Record<string, unknown>) => serverApp({ source: "issuer", issuer: { ...ISSUER, ...issuer } });

  it("stores one issuer or audience as a list", () => {
    const config = parseAppConfig(withIssuer({ audience: ["a", "b"] }));
    const endUser = config.authentication.end_user as { issuer: { issuer: string[]; audience: string[] } };
    expect(endUser.issuer.issuer).toEqual(["https://issuer.example.test"]);
    expect(endUser.issuer.audience).toEqual(["a", "b"]);
  });

  it.each([
    ["an http key set", { jwks_url: "http://issuer.example.test/jwks.json" }],
    ["a key set that is not a URL", { jwks_url: "issuer.example.test/jwks.json" }],
  ])("refuses %s", (_label, change) => {
    expect(problem(withIssuer(change))).toContain("Issuer JWKS URLs must be valid and use HTTPS");
  });

  it("stores the key set URL in its canonical form", () => {
    const config = parseAppConfig(withIssuer({ jwks_url: "https://ISSUER.example.test:443/a/../jwks.json" }));
    expect((config.authentication.end_user as { issuer: { jwks_url: string } }).issuer.jwks_url).toBe("https://issuer.example.test/jwks.json");
  });

  it.each([
    ["no issuer", { issuer: undefined }],
    ["no audience", { audience: undefined }],
    ["an empty audience list", { audience: [] }],
    ["no user id claim", { user_id_claim: "" }],
    ["a lifetime of zero", { max_token_lifetime_seconds: 0 }],
    ["a fractional lifetime", { max_token_lifetime_seconds: 1.5 }],
  ])("refuses an issuer with %s", (_label, change) => {
    expect(() => parseAppConfig(withIssuer(change))).toThrow(ConfigError);
  });

  it.each([
    ["both contains and equals", { path: "plan", contains: "pro", equals: "pro" }],
    ["neither contains nor equals", { path: "plan" }],
    ["a blank path", { path: "  ", equals: "pro" }],
    ["a blank value", { path: "plan", contains: " " }],
  ])("refuses a required claim with %s", (_label, claim) => {
    expect(() => parseAppConfig(withIssuer({ required_claims: [claim] }))).toThrow(ConfigError);
  });

  it("accepts a required claim that contains one of several values or equals a number or a flag", () => {
    expect(() =>
      parseAppConfig(withIssuer({ required_claims: [{ path: "plan", contains: ["pro", "team"] }, { path: "level", equals: 3 }, { path: "paid", equals: true }] })),
    ).not.toThrow();
  });

  it.each(["authorization", "cookie", "x-appattest-proof", "x-app-version", "Content-Type"])(
    "refuses the gateway's own %s header as the token header",
    (header) => {
      expect(problem(withIssuer({ token_header: header }))).toContain("the gateway already uses that header");
    },
  );

  it("refuses a provider's key header as an end user or token header only when saving", () => {
    const named = parseAppConfig(serverApp({ source: "header", header: "x-api-key" }));
    expect(providerKeyHeaderProblem(named)).toContain("the gateway already uses that header");
    expect(providerKeyHeaderProblem(parseAppConfig(serverApp({ source: "header", header: "x-player-id" })))).toBeNull();
  });

  it.each(["has space", "", "x".repeat(65), "x:player"])("refuses %j as an end user header", (header) => {
    expect(() => parseAppConfig(serverApp({ source: "header", header }))).toThrow(ConfigError);
  });

  it("lowercases the end user and token headers, since header lookups ignore case", () => {
    const config = parseAppConfig(serverApp({ source: "header", header: "X-Player-ID" }));
    expect((config.authentication.end_user as { header: string }).header).toBe("x-player-id");
  });
});

describe("App Attest settings", () => {
  it.each([
    ["a short team id", { team_id: "AAAA" }, "team_id must contain ten uppercase letters or digits"],
    ["a lowercase team id", { team_id: "aaaaaaaaaa" }, "team_id must contain ten uppercase letters or digits"],
    ["a bundle id with no dot", { bundle_id: "app" }, "bundle_id must be a reverse DNS identifier"],
    ["no environments", { environments: [] }, "environments must name at least one environment"],
    ["a repeated environment", { environments: ["production", "production"] }, "environments cannot repeat a value"],
    ["an unknown environment", { environments: ["staging"] }, "environments"],
    ["an unknown verify_on", { verify_on: "sometimes" }, "verify_on must be one of every_request, token_exchange"],
  ])("refuses %s", (_label, change, message) => {
    expect(problem(attestApp(change))).toContain(message);
  });

  it("trims the team and bundle ids", () => {
    const config = parseAppConfig(attestApp({ team_id: " AAAAAAAAAA ", bundle_id: " com.example.app " }));
    expect(config.authentication).toMatchObject({ app_attest: ATTEST });
  });

  it("allows only the end users that mean something for each app type", () => {
    expect(problem(attestApp({}, { source: "header", header: "x-player-id" }))).toContain("must be one of issuer, app_install");
    expect(problem(attestApp({}, { source: "none" }))).toContain("must be one of issuer, app_install");
    expect(problem(serverApp({ source: "app_install" }))).toContain("must be one of none, header, issuer");
  });

  it("reads the authentication of a stored configuration on its own, naming the field at fault", () => {
    expect(parseAuthentication(attestApp())).toMatchObject({ type: "apple_app_attest" });
    expect(() => parseAuthentication(attestApp({ team_id: "x" }))).toThrow("authentication.app_attest.team_id");
    expect(() => parseAuthentication(null)).toThrow(ConfigError);
  });
});

describe("rules across sections", () => {
  it("refuses per-user limits for an app that names no end users", () => {
    expect(problem({ ...serverApp(), limits: { per_user: { requests: { per_minute: 5 } } } })).toContain("limits.per_user");
  });

  it("refuses a per-install budget on a server app", () => {
    expect(problem({ ...serverApp({ source: "header", header: "x-player-id" }), limits: { per_user: { spending: { scope: "install" } } } }))
      .toContain("server apps have no install or Apple Account");
  });

  it("refuses a per-user budget on an App Attest app with no signed-in user", () => {
    expect(problem({ ...attestApp(), limits: { per_user: { spending: { scope: "user" } } } })).toContain("no signed-in user");
    expect(() =>
      AppConfigSchema.parse({ ...attestApp({}, { source: "issuer", issuer: ISSUER }), limits: { per_user: { spending: { scope: "user" } } } }),
    ).not.toThrow();
  });
});
