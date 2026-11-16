import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppCheckResponse, AppResponse, AppValidateResponse, AppWarning } from "../src/contracts/responses";
import { parseAppConfig } from "../src/shared/app-config";
import { appWarnings } from "../src/management/app-warnings";
import { seedHuman, seedProvider, seedServerApp } from "./helpers";

/**
 * An app's warnings: what its owner should know about its settings. The one
 * there is today names the passthrough paths that let an app talk to a
 * provider's realtime API directly, out of the gateway's sight. A warning never refuses a save: the
 * app is saved as sent, and every read and save after says it again.
 */

const ORIGIN = "https://example.test";
const GUIDE = "https://docs.appaigateway.com/integrate/realtime/#instead-of-client-secrets";

function config(selected: Record<string, unknown>) {
  return parseAppConfig({
    authentication: { type: "api_key", end_user: { source: "none" } },
    routing: { providers: { mode: "selected", selected }, model_rewrites: {} },
  });
}

const policy = (allowed_paths: unknown[]) => ({ allowed_paths, allowed_models: [] });

describe("appWarnings", () => {
  const openai = { slug: "openai", type: "openai" as const };

  it("names one listed client secrets path, as configured", () => {
    expect(appWarnings(config({ openai: policy(["v1/responses", "v1/realtime/client_secrets"]) }), [openai])).toEqual([{
      code: "realtime_client_secrets",
      message: "You configured `v1/realtime/client_secrets` for provider \"openai\". This endpoint lets your app talk to OpenAI directly, so the gateway can't count, limit or record those conversations. Use realtime through the gateway instead, then remove this endpoint.",
      docs_url: GUIDE,
    }]);
  });

  it("names every such path of a provider in one warning", () => {
    const warnings = appWarnings(config({
      voice: policy([
        { path: "v1/realtime/client_secrets", methods: ["POST"] },
        "/v1/realtime/sessions",
        "v1/realtime/transcription_sessions",
      ]),
    }), [{ slug: "voice", type: "openai" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(
      "You configured `v1/realtime/client_secrets`, `/v1/realtime/sessions` and `v1/realtime/transcription_sessions` for provider \"voice\". These endpoints let your app talk to OpenAI directly, so the gateway can't count, limit or record those conversations. Use realtime through the gateway instead, then remove these endpoints.",
    );
  });

  it("warns about xAI's and Gemini's own paths, without suggesting realtime the gateway doesn't run for them", () => {
    const app = config({
      grok: policy(["v1/realtime/client_secrets"]),
      live: policy(["v1alpha/auth_tokens", "v1beta/auth_tokens"]),
    });
    expect(appWarnings(app, [{ slug: "grok", type: "xai" }, { slug: "live", type: "gemini" }])).toEqual([
      {
        code: "realtime_client_secrets",
        message: "You configured `v1/realtime/client_secrets` for provider \"grok\". This endpoint lets your app talk to xAI directly, so the gateway can't count, limit or record those conversations.",
      },
      {
        code: "realtime_client_secrets",
        message: "You configured `v1alpha/auth_tokens` and `v1beta/auth_tokens` for provider \"live\". These endpoints let your app talk to Gemini directly, so the gateway can't count, limit or record those conversations.",
      },
    ]);
  });

  it("says nothing of another provider type's paths, an unlisted path, or a slug with no provider", () => {
    const app = config({
      claude: policy(["v1/realtime/client_secrets", "v1beta/auth_tokens"]),
      grok: policy(["v1alpha/auth_tokens"]),
      openai: policy([]),
      gone: policy(["v1/realtime/client_secrets"]),
    });
    expect(appWarnings(app, [{ slug: "claude", type: "anthropic" }, { slug: "grok", type: "xai" }, openai])).toEqual([]);
    expect(appWarnings(parseAppConfig({
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
    }), [openai])).toEqual([]);
  });
});

describe("warnings through the API", () => {
  async function account(email: string) {
    const human = await seedHuman(email);
    const created = await exports.default.fetch(`${ORIGIN}/v1/admin/keys`, {
      method: "POST",
      headers: { cookie: human.cookie, "x-console-request": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "Warnings", grant: "manage" }),
    });
    const { key } = await created.json<{ key: { plaintext: string } }>();
    return {
      organizationId: human.organizationId,
      headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
    };
  }

  async function call<T>(method: string, path: string, headers: Record<string, string>, body?: unknown) {
    const response = await exports.default.fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json<T>() };
  }

  const codes = (warnings: readonly AppWarning[]) => warnings.map((warning) => warning.code);

  it("saves the path as sent, and every read, save, validation and check warns about it", async () => {
    const { organizationId, headers } = await account("warnings-client-secrets@example.test");
    await seedProvider({ type: "openai", slug: "openai", organizationId, id: `${organizationId}-openai` });
    await seedServerApp("warnings-app", { organizationId, proxy: { openai: policy(["v1/responses"]) } });

    const before = await call<AppResponse>("GET", "/v1/admin/apps/warnings-app", headers);
    expect(before.body.app.warnings).toEqual([]);

    const { id: _id, created_at: _c, updated_at: _u, warnings: _w, ...document } = before.body.app;
    const listed = structuredClone(document);
    (listed.config.routing.providers as { selected: Record<string, { allowed_paths: unknown[] }> })
      .selected.openai!.allowed_paths.push("v1/realtime/client_secrets");

    const { revision: _revision, ...unsaved } = listed;
    const validated = await call<AppValidateResponse>("POST", "/v1/admin/apps/warnings-app/validate", headers, unsaved);
    expect(validated.status).toBe(200);
    expect(codes(validated.body.warnings)).toEqual(["realtime_client_secrets"]);

    const saved = await call<AppResponse>("PUT", "/v1/admin/apps/warnings-app", headers, listed);
    expect(saved.status).toBe(200);
    expect(codes(saved.body.app.warnings)).toEqual(["realtime_client_secrets"]);
    expect(JSON.stringify(saved.body.app.config)).toContain("v1/realtime/client_secrets");

    // An edit of another setting still warns while the path stays.
    const renamed = await call<AppResponse>("PATCH", "/v1/admin/apps/warnings-app", headers, {
      revision: saved.body.app.revision,
      operations: [{ op: "replace", path: "/name", value: "Renamed" }],
    });
    expect(renamed.status).toBe(200);
    expect(codes(renamed.body.app.warnings)).toEqual(["realtime_client_secrets"]);

    const read = await call<AppResponse>("GET", "/v1/admin/apps/warnings-app", headers);
    expect(read.body.app.warnings).toEqual(renamed.body.app.warnings);

    const checked = await call<AppCheckResponse>("GET", "/v1/admin/apps/warnings-app/check", headers);
    expect(checked.body.ready).toBe(true);
    expect(codes(checked.body.warnings)).toEqual(["realtime_client_secrets"]);
    expect(checked.body.validation).toEqual({ valid: true, app_id: "warnings-app" });
  });
});
