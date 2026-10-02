import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CredentialGrant } from "@maxceem/cf-auth";
import type { AppCheckResponse, AppSnippetResponse } from "../src/contracts/responses";
import worker from "../src/index";
import { TEST_MANAGEMENT_KEY } from "./apply-migrations";
import { seedApp, seedHuman, seedProvider, seedServerApp } from "./helpers";

/**
 * `checkApp` and `getAppSnippet`: the two reads that tell whoever manages an
 * application whether it can serve and what its first request looks like,
 * answered by the gateway so every transport gets the same answer.
 *
 * Each test works in an account of its own, so the providers it seeds are the
 * only ones its applications can see.
 */

const ORIGIN = "https://example.test";

/** An owner of a fresh account, and a management key they made in the console. */
async function account(email: string, grant: CredentialGrant = "manage") {
  const human = await seedHuman(email);
  const created = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
    method: "POST",
    headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
    body: JSON.stringify({ name: "Checker", grant }),
  });
  expect(created.status).toBe(201);
  const { key } = await created.json<{ key: { plaintext: string } }>();
  return {
    organizationId: human.organizationId,
    headers: { authorization: `Bearer ${key.plaintext}` },
  };
}

/** One direct provider in an account, under a slug of the test's choosing. */
function provider(
  organizationId: string,
  slug: string,
  type: "openai" | "anthropic",
  status: "active" | "disabled" = "active",
) {
  return seedProvider({ type, slug, organizationId, id: `${organizationId}-${slug}`, status });
}

const open = { allowed_paths: [], allowed_models: [] };

async function read<T>(path: string, headers: Record<string, string>): Promise<{ status: number; body: T }> {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, { headers });
  return { status: response.status, body: await response.json<T>() };
}

const check = (app: string, headers: Record<string, string>) =>
  read<AppCheckResponse>(`/v1/admin/apps/${app}/check`, headers);

const snippet = (app: string, headers: Record<string, string>, query = "") =>
  read<AppSnippetResponse & { error?: { code: string; message: string } }>(
    `/v1/admin/apps/${app}/snippet${query}`,
    headers,
  );

describe("checkApp", () => {
  it("reports a provider the routing names but is paused, and is not ready on it", async () => {
    const { organizationId, headers } = await account("check-paused@example.test");
    await provider(organizationId, "claude", "anthropic", "disabled");
    await seedServerApp("check-paused-app", { organizationId, proxy: { claude: open } });

    const { status, body } = await check("check-paused-app", headers);
    expect(status).toBe(200);
    expect(body).toEqual({
      appId: "check-paused-app",
      validation: { valid: true, app_id: "check-paused-app" },
      status: "active",
      providers: [{ id: `${organizationId}-claude`, slug: "claude", status: "disabled" }],
      ready: false,
      limitations: [
        "No inference was sent.",
        "Physical device attestation, issuer login, subscription entitlement and upstream credentials were not exercised.",
      ],
    });
  });

  it("is ready once one provider it names is active, and lists only the ones it names", async () => {
    const { organizationId, headers } = await account("check-ready@example.test");
    await provider(organizationId, "openai", "openai");
    await provider(organizationId, "claude", "anthropic", "disabled");
    await provider(organizationId, "unnamed", "openai");
    await seedServerApp("check-ready-app", { organizationId, proxy: { openai: open, claude: open } });

    const { status, body } = await check("check-ready-app", headers);
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.providers.map(({ slug, status }) => [slug, status]).sort()).toEqual([
      ["claude", "disabled"],
      ["openai", "active"],
    ]);
  });

  it("is not ready while the application itself is disabled", async () => {
    const { organizationId, headers } = await account("check-disabled@example.test");
    await provider(organizationId, "openai", "openai");
    await seedServerApp("check-disabled-app", { organizationId, proxy: { openai: open } });
    await env.DB.prepare("UPDATE app SET status='disabled' WHERE id=?").bind("check-disabled-app").run();

    const { body } = await check("check-disabled-app", headers);
    expect(body).toMatchObject({ status: "disabled", ready: false });
  });

  it("answers a stored configuration that no longer parses as a refusal of the configuration", async () => {
    const { organizationId, headers } = await account("check-malformed@example.test");
    await seedServerApp("check-malformed-app", { organizationId, proxy: { provider_mode: "all" } });
    await env.DB.prepare("UPDATE app SET config_json='{}' WHERE id=?").bind("check-malformed-app").run();

    const response = await read<{ error: { code: string; message: string } }>(
      "/v1/admin/apps/check-malformed-app/check",
      headers,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("invalid_request");
    // The schema's own sentence, as every configuration refusal words it.
    expect(response.body.error.message).not.toBe("");
    expect(response.body.error.message).not.toMatch(/stored|internal/iu);
  });

  it("names every provider an all-mode application reaches", async () => {
    const { organizationId, headers } = await account("check-all@example.test");
    await provider(organizationId, "openai", "openai");
    await provider(organizationId, "claude", "anthropic", "disabled");
    await seedServerApp("check-all-app", { organizationId, proxy: { provider_mode: "all" } });

    const { body } = await check("check-all-app", headers);
    expect(body.ready).toBe(true);
    expect(body.providers.map(({ slug }) => slug).sort()).toEqual(["claude", "openai"]);
  });
});

describe("getAppSnippet", () => {
  it("writes curl for a server application, against the app and the API URL, with no key in it", async () => {
    const { organizationId, headers } = await account("snippet-server@example.test");
    await provider(organizationId, "openai", "openai");
    const key = await seedServerApp("snippet-server-app", {
      organizationId,
      proxy: { openai: { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } },
    });

    const { status, body } = await snippet("snippet-server-app", headers);
    expect(status).toBe(200);
    expect(body.language).toBe("shell");
    expect(body.snippet).toContain(`'${ORIGIN}/v1/apps/snippet-server-app/proxy/openai/v1/responses'`);
    expect(body.snippet).toContain('{"model":"gpt-5.6-sol","input":"Say hello."}');
    expect(body.snippet).toContain('-H "Authorization: Bearer $APP_AI_GATEWAY_KEY"');
    // Neither the application's own key nor the one this request was made with.
    expect(body.snippet).not.toContain(key);
    expect(body.snippet).not.toContain(headers.authorization.slice("Bearer ".length));
    expect(body.snippet).not.toContain("agw_");
    expect(body.notes).toEqual([]);
  });

  it("names what a new application does not have yet, in the notes and in the snippet", async () => {
    const { organizationId, headers } = await account("snippet-bare@example.test");
    await seedServerApp("snippet-bare-app", { organizationId, proxy: { provider_mode: "all" } });

    const { body } = await snippet("snippet-bare-app", headers);
    expect(body.snippet).toContain("/proxy/PROVIDER_SLUG/v1/chat/completions");
    expect(body.snippet).toContain('"model":"MODEL"');
    expect(body.notes).toHaveLength(2);
    expect(body.snippet).toMatch(/^# No provider is configured yet/u);
  });

  it("shows the first of several reachable providers and writes for another on request", async () => {
    const { organizationId, headers } = await account("snippet-several@example.test");
    await provider(organizationId, "openai", "openai");
    await provider(organizationId, "claude", "anthropic");
    await seedServerApp("snippet-several-app", { organizationId, proxy: { provider_mode: "all" } });

    const first = await snippet("snippet-several-app", headers);
    expect(first.body.notes[0]).toBe("This app can reach 2 providers. Ask for provider=<slug> for a different one.");
    expect(first.body.snippet).toMatch(/^# This app can reach 2 providers/u);

    const named = await snippet("snippet-several-app", headers, "?provider=claude");
    expect(named.status).toBe(200);
    expect(named.body.snippet).toContain("/proxy/claude/v1/messages");
    expect(named.body.snippet).toContain("anthropic-version: 2023-06-01");
    expect(named.body.notes.some((note) => note.startsWith("This app can reach"))).toBe(false);
  });

  it("calls a custom endpoint by name, and refuses one the app does not have", async () => {
    const { organizationId, headers } = await account("snippet-endpoint@example.test");
    await provider(organizationId, "openai", "openai");
    await seedServerApp("snippet-endpoint-app", {
      organizationId,
      proxy: { openai: { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] } },
      endpoints: {
        chat: { api_style: "responses", provider: "openai", model: "gpt-5.6-sol" },
      },
    });

    const named = await snippet("snippet-endpoint-app", headers, "?endpoint=chat");
    expect(named.status).toBe(200);
    expect(named.body.snippet).toContain(`'${ORIGIN}/v1/apps/snippet-endpoint-app/endpoints/chat'`);
    expect(named.body.snippet).toContain('{"input":"Say hello."}');

    for (const name of ["missing", "constructor"]) {
      const missing = await snippet("snippet-endpoint-app", headers, `?endpoint=${name}`);
      expect(missing.status, name).toBe(404);
      expect(missing.body.error?.code, name).toBe("endpoint_not_found");
    }
  });

  it("tells a provider that does not exist from one the app cannot reach", async () => {
    const { organizationId, headers } = await account("snippet-providers@example.test");
    await provider(organizationId, "openai", "openai");
    await provider(organizationId, "paused", "openai", "disabled");
    await provider(organizationId, "outside", "anthropic");
    await seedServerApp("snippet-providers-app", {
      organizationId,
      proxy: { openai: open, paused: open },
    });

    const absent = await snippet("snippet-providers-app", headers, "?provider=absent");
    expect(absent.status).toBe(404);
    expect(absent.body.error?.code).toBe("provider_not_found");

    for (const slug of ["paused", "outside"]) {
      const unavailable = await snippet("snippet-providers-app", headers, `?provider=${slug}`);
      expect(unavailable.status, slug).toBe(400);
      expect(unavailable.body.error?.code, slug).toBe("provider_unavailable");
    }
  });

  it("offers each application type only the language its callers can authenticate with", async () => {
    const { organizationId, headers } = await account("snippet-languages@example.test");
    await provider(organizationId, "openai", "openai");
    await seedServerApp("snippet-languages-server", { organizationId, proxy: { openai: open } });
    await seedApp("snippet-languages-ios", { organizationId, proxy: { openai: open } });

    const swift = await snippet("snippet-languages-ios", headers);
    expect(swift.status).toBe(200);
    expect(swift.body.language).toBe("swift");
    expect(swift.body.snippet).toContain("import AppAIGateway");
    expect(swift.body.snippet).toContain('appID: "snippet-languages-ios"');
    expect(swift.body.snippet).toContain(`baseURL: URL(string: "${ORIGIN}")!`);
    expect(swift.body.snippet).toContain('providerPath: "v1/responses"');
    // The seeded iOS app signs its users in with an issuer.
    expect(swift.body.snippet).toContain("issuerTokenProvider");
    expect(swift.body.notes.at(-1)).toMatch(/^Replace yourIdentitySDK/u);

    const curl = await snippet("snippet-languages-ios", headers, "?language=curl");
    expect(curl.status).toBe(400);
    expect(curl.body.error).toEqual({
      code: "unsupported_snippet",
      message: "iOS applications authenticate with App Attest, which curl cannot perform. Ask for language=swift.",
    });

    const server = await snippet("snippet-languages-server", headers, "?language=swift");
    expect(server.status).toBe(400);
    expect(server.body.error).toEqual({
      code: "unsupported_snippet",
      message: "Swift snippets are for iOS applications. Ask for language=curl.",
    });

    const other = await snippet("snippet-languages-server", headers, "?language=python");
    expect(other.status).toBe(400);
    expect(other.body.error).toMatchObject({ code: "invalid_request" });
  });

  it("writes against the separate API host a deployment publishes", async () => {
    const { organizationId, headers } = await account("snippet-api-host@example.test");
    await seedServerApp("snippet-api-host-app", { organizationId, proxy: { provider_mode: "all" } });
    const published = new Proxy(env, {
      get: (target, key, receiver) =>
        key === "PUBLIC_API_URL" ? "https://api.example.test" : Reflect.get(target, key, receiver),
    }) as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/admin/apps/snippet-api-host-app/snippet`, { headers }),
      published,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json<AppSnippetResponse>();
    expect(body.snippet).toContain("'https://api.example.test/v1/apps/snippet-api-host-app/proxy/");
  });
});

describe("who may check an application or ask for its example", () => {
  it("lets a member's read key do both", async () => {
    const { organizationId, headers } = await account("check-member-read@example.test", "read");
    await provider(organizationId, "openai", "openai");
    await seedServerApp("check-member-read-app", { organizationId, proxy: { openai: open } });
    await env.DB.prepare("UPDATE mgmt_organization_user SET role='member' WHERE organization_id=?")
      .bind(organizationId)
      .run();

    const checked = await check("check-member-read-app", headers);
    expect(checked.status).toBe(200);
    expect(checked.body.ready).toBe(true);
    const example = await snippet("check-member-read-app", headers);
    expect(example.status).toBe(200);
    expect(example.body.language).toBe("shell");
  });

  it("does not find another account's application", async () => {
    const { organizationId, headers } = await account("check-elsewhere@example.test");
    await seedServerApp("check-elsewhere-app", { organizationId, proxy: { provider_mode: "all" } });
    const operator = { authorization: `Bearer ${TEST_MANAGEMENT_KEY}` };

    for (const path of ["check", "snippet"]) {
      const response = await read<{ error: { code: string } }>(
        `/v1/admin/apps/check-elsewhere-app/${path}`,
        operator,
      );
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("app_not_found");
    }
    // Its own account finds it.
    expect((await check("check-elsewhere-app", headers)).status).toBe(200);
  });
});
