/**
 * Custom providers (plan section 4.5, step 5b): a provider the gateway does
 * not know, at the base URL a customer names, with the key in the header they
 * name. Its listed paths are passed through, unless one names an API style:
 * then it is metered by that style at the connection's rates. The provider is
 * mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { CUSTOM_PATH_STYLES } from "../src/contracts/admin.ts";
import { describeConnection } from "../src/providers/connections.ts";
import {
  CARRIED,
  CUSTOM_STYLES,
  customAuthProblem,
  customDescription,
  customOperation,
  customOperationName,
  customStyleProblem,
  declaredHostNames,
  knownHostOwner,
  styleSource,
} from "../src/providers/custom.ts";
import { reportsCost } from "../src/pricing/prices.ts";
import { meterCases } from "../src/pricing/units.ts";
import { hasMeasure } from "../src/usage/observation.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { readingRules, type OperationDescription } from "../src/providers/operation.ts";
import { clientAuth, requestCredential } from "../src/client-auth/client-auth.ts";
import { openai } from "../src/providers/openai.ts";
import { storedPassthrough } from "../src/providers/passthrough.ts";
import { declaredOperation } from "../src/providers/presets.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedAccount, seedAppKey, seedManagementKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-custom-provider-key-9876";
const BASE = "https://llm.example.com/v1/";
const AUTH = { header: "x-api-key", format: "Key {key}" };

let fetchSpy: MockInstance<typeof fetch>;

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("a custom provider's description", () => {
  it("offers exactly the styles the contract lists, each a POST operation named after it", () => {
    expect([...CUSTOM_STYLES].sort()).toEqual([...CUSTOM_PATH_STYLES].sort());
    for (const style of CUSTOM_STYLES) {
      const operation = declaredOperation(customOperationName(style));
      expect(operation, style).toMatchObject({ name: `custom.${style}`, style, match: { method: "POST" } });
    }
  });

  it("has its base URL's host as its only host", () => {
    const description = customDescription({ baseUrl: BASE, auth: AUTH, paths: [] });
    expect(description).toMatchObject({ type: "custom", hosts: { main: "llm.example.com" }, auth: AUTH, operations: [] });
  });

  it("knows a built-in provider's host, a regional one included, for the styles it reads there", () => {
    expect(knownHostOwner("https://api.openai.com/v1/")?.type).toBe("openai");
    expect(knownHostOwner("https://API.OPENAI.COM/")?.type).toBe("openai");
    expect(knownHostOwner("https://openrouter.ai/api/")?.type).toBe("openrouter");
    expect(knownHostOwner("https://api.eu.mistral.ai/")?.type).toBe("mistral");
    expect(knownHostOwner("https://openai.example.com/")).toBeNull();
    // Only its base URL's host, wherever it is: it serves only the paths listed.
    expect(customDescription({ baseUrl: "https://api.openai.com/v1/", auth: AUTH, paths: [] }).hosts).toEqual({ main: "api.openai.com" });
  });

  it("turns each API-style path into its operation, and leaves plain paths to passthrough", () => {
    const description = customDescription({
      baseUrl: BASE,
      auth: AUTH,
      paths: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models" },
      ],
    });
    expect(description.operations.map((operation) => [operation.name, operation.match.path])).toEqual([["custom.openai-chat", "chat/completions"]]);
  });

  it("declares every host a provider prices apart among its hosts, and finds the owner of each", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      for (const origin of Object.keys(description.regionalOrigins ?? {})) {
        expect(declaredHostNames(description), origin).toContain(new URL(origin).hostname);
        expect(knownHostOwner(origin)?.type).toBe(description.type);
      }
    }
    expect(knownHostOwner("https://eu.api.openai.com/v1/")?.type).toBe("openai");
    expect(knownHostOwner("https://api.eu.residency.elevenlabs.io/")?.type).toBe("elevenlabs");
  });

  it("knows every host a provider declares, and every host under a `*.` one, as that provider's", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      for (const name of description.otherHosts ?? []) {
        const host = name.startsWith("*.") ? `jp${name.slice(1)}` : name;
        expect(knownHostOwner(`https://${host}/`)?.type, host).toBe(description.type);
      }
    }
    for (const host of ["us.api.openai.com", "gb.api.openai.com", "eu.api.openai.com", "jp.api.openai.com"]) {
      expect(knownHostOwner(`https://${host}/v1/`)?.type, host).toBe("openai");
    }
    // Only under it: a look-alike name is not OpenAI's.
    expect(knownHostOwner("https://api.openai.com.example.net/")).toBeNull();
  });

  it("builds an API-style path from a built-in definition, with that provider's rules for reading it", () => {
    const unknown = customDescription({
      baseUrl: BASE,
      auth: AUTH,
      paths: [
        { method: "POST", path: "chat", style: "openai-chat" },
        { method: "POST", path: "messages", style: "anthropic-messages" },
        { method: "POST", path: "stt", style: "openai-transcription" },
      ],
    });
    const [chatOp, messagesOp, sttOp] = unknown.operations as [OperationDescription, OperationDescription, OperationDescription];
    expect(readingRules(unknown, chatOp).serviceModes).toBe(openai.serviceModes);
    expect(readingRules(unknown, messagesOp).serviceModes).toBe(BUILT_IN_PROVIDERS.anthropic!.serviceModes);
    expect(readingRules(unknown, sttOp).transcriptionFormats).toBe(openai.transcriptionFormats);
    // OpenAI's own Chat Completions writes its cap where OpenAI reads it.
    expect(chatOp.policy?.outputCap).toBe(BUILT_IN_PROVIDERS.openai!.operations.find((one) => one.name === "openai.chat")!.policy?.outputCap);
    // On a known host, that provider's own definition and rules.
    const groq = customDescription({ baseUrl: "https://api.groq.com/openai/v1/", auth: AUTH, paths: [{ method: "POST", path: "chat/completions", style: "openai-chat" }] });
    expect(readingRules(groq, groq.operations[0]).serviceModes).toBe(BUILT_IN_PROVIDERS.groq!.serviceModes);
  });

  it("carries every field of a built-in definition as `CARRIED` says, for every provider and style", () => {
    let judged = 0;
    for (const owner of [null, ...Object.values(BUILT_IN_PROVIDERS)]) {
      for (const style of CUSTOM_STYLES) {
        const { provider, definition } = styleSource(style, owner);
        if (definition === null) continue;
        const custom = customOperation(style, "listed/path", owner);
        judged += 1;
        for (const field of Object.keys(CARRIED) as (keyof OperationDescription)[]) {
          const where = `${provider.type} ${style} ${field}`;
          if (CARRIED[field] === "kept") expect(custom[field], where).toEqual(definition[field]);
          if (CARRIED[field] === "refused") expect(custom[field], where).toBeUndefined();
        }
        expect(custom.name).toBe(`custom.${style}`);
        expect(custom.match).toEqual({ method: "POST", path: "listed/path" });
        // The meter is the definition's, never with the provider's own dollar report.
        const { providerCost: _report, ...meter } = definition.meter as typeof definition.meter & { providerCost?: unknown };
        expect(custom.meter, `${provider.type} ${style} meter`).toEqual(meter);
        expect(reportsCost(custom)).toBe(false);
        expect(custom.rules?.serviceModes).toBe(provider.serviceModes);
        expect(custom.rules?.alternativeModels).toBe(provider.alternativeModels);
        expect(custom.rules?.modelNamespaces).toBe(provider.modelNamespaces);
      }
    }
    expect(judged).toBeGreaterThan(CUSTOM_STYLES.length);
  });

  it("allows on a custom path only a style every answer of which a rate can price, for every provider that defines it", () => {
    const refused: string[] = [];
    for (const owner of [null, ...Object.values(BUILT_IN_PROVIDERS)]) {
      const baseUrl = owner === null ? BASE : `https://${owner.hosts.main.split("/")[0]}/`;
      for (const style of CUSTOM_STYLES) {
        const unmetered = meterCases(customOperation(style, style, owner)).some((way) => way.some((usage) => !hasMeasure(usage)));
        const problem = customStyleProblem(style, baseUrl);
        expect(problem !== null, `${owner?.type ?? "unknown"} ${style}`).toBe(unmetered || (problem?.includes("cannot (") ?? false));
        if (problem !== null) refused.push(`${owner?.type ?? "unknown"} ${style}`);
      }
    }
    // xAI's images report only their cost; every other style on every host can be priced from rates.
    expect(refused).toEqual(["xai openai-images"]);
  });

  it("reads Kimi's one-hour cache writes from its header on a custom Moonshot chat path, as on Moonshot's own", () => {
    const description = customDescription({ baseUrl: "https://api.moonshot.ai/", auth: AUTH, paths: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }] });
    const meter = description.operations[0]!.meter;
    expect(meter.kind === "response_json" ? meter.usageHeaders : undefined).toEqual([{ header: "msh-usage-cache-write-tokens-1h", bucket: "cache_write", name: "1h" }]);
  });

  it("bills an xAI chat path at the connection's rates, never at xAI's own dollar report", () => {
    const description = customDescription({ baseUrl: "https://api.x.ai/", auth: AUTH, paths: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }] });
    const xaiChat = BUILT_IN_PROVIDERS.xai!.operations.find((one) => one.style === "openai-chat")!;
    expect(reportsCost(xaiChat)).toBe(true);
    expect(reportsCost(description.operations[0]!)).toBe(false);
  });

  it("is null for a custom row without its base URL or key header, which no save stores", () => {
    expect(describeConnection({ type: "custom", baseUrl: null, customAuth: AUTH })).toBeNull();
    expect(describeConnection({ type: "custom", baseUrl: BASE, customAuth: null })).toBeNull();
  });

  it.each([
    [{ header: "authorization", format: "Bearer {key}" }, null],
    [{ header: "x-api-key", format: "{key}" }, null],
    [{ header: "host", format: "{key}" }, "cannot carry the key"],
    [{ header: "content-type", format: "{key}" }, "cannot carry the key"],
    [{ header: "cf-aig-authorization", format: "{key}" }, "cannot carry the key"],
    [{ header: "x api key", format: "{key}" }, "header name"],
    [{ header: "x-end-user-id", format: "{key}" }, "reads who is calling from it"],
    [{ header: "x-api-key", format: "Bearer key" }, "{key} exactly once"],
    [{ header: "x-api-key", format: "{key}{key}" }, "{key} exactly once"],
    [{ header: "x-api-key", format: "Bearer\n{key}" }, "printable ASCII"],
  ])("judges the key header %j", (auth, problem) => {
    const found = customAuthProblem(auth);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toContain(problem);
  });
});

async function admin(key: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const PRICING = { "local-llm": { input: 1, output: 2 } };

const createCustom = (key: string, fields: Record<string, unknown> = {}) =>
  admin(key, "POST", "/v2/admin/providers", {
    type: "custom",
    name: "My LLM",
    slug: `my-llm-${crypto.randomUUID().slice(0, 6)}`,
    secret: SECRET,
    baseUrl: BASE,
    auth: AUTH,
    ...fields,
  });

describe("saving a custom provider", () => {
  it("stores its base URL, key header and paths, and shows them back without the key", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      passthrough: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", per_request: 0.001 },
      ],
      pricing: PRICING,
    });
    expect(created.status).toBe(201);
    expect(created.body.provider).toMatchObject({
      type: "custom",
      baseUrl: BASE,
      auth: AUTH,
      secretHint: "9876",
      passthrough: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", per_request: 0.001 },
      ],
    });
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    const row = await env.DB.prepare("SELECT passthrough_json FROM provider_connection WHERE id = ?").bind(created.body.provider.id).first<{ passthrough_json: string }>();
    expect(JSON.parse(row!.passthrough_json)).toEqual({
      paths: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "GET", path: "models", price_nano: 1_000_000 },
      ],
      auth: AUTH,
    });
    // A built-in provider shows no key header.
    const builtIn = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: `oa-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-live-secret-abcd" });
    expect(builtIn.body.provider.auth).toBeUndefined();
  });

  it("keeps its key header when its paths are cleared, and takes a new one", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "GET", path: "models" }] });
    const id = created.body.provider.id as string;
    const cleared = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, passthrough: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.provider.auth).toEqual(AUTH);
    expect(cleared.body.provider.passthrough).toBeUndefined();
    const moved = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, auth: { header: "authorization", format: "Bearer {key}" } });
    expect(moved.status).toBe(200);
    expect(moved.body.provider.auth).toEqual({ header: "authorization", format: "Bearer {key}" });
  });

  it.each([
    [{ baseUrl: undefined }, "base URL"],
    [{ auth: undefined }, "header its key is sent in"],
    [{ auth: { header: "host", format: "{key}" } }, "cannot carry the key"],
    [{ auth: { header: "x-api-key", format: "Bearer token" } }, "{key} exactly once"],
    [{ baseUrl: "http://llm.example.com/" }, "https"],
    [{ baseUrl: "https://10.0.0.8/" }, "IP address"],
    [{ baseUrl: "https://[::1]/" }, "IPv6"],
    [{ baseUrl: "https://localhost/" }, "public domain name"],
    [{ baseUrl: "https://llm.internal/" }, "reserved local name"],
    [{ baseUrl: "https://llm.example.com:8443/" }, "port"],
    [{ baseUrl: "https://user:pass@llm.example.com/" }, "credentials"],
    [{ baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/" }, "Cloudflare AI Gateway is not a custom provider"],
    [{ cloudflareGateway: { accountId: "a", gatewayId: "g", token: "cf-token-for-tests-1234" } }, "base URL only"],
    [{ servingProviders: ["openai"] }, "no serving providers"],
    [{ passthrough: [{ method: "GET", path: "chat/completions", style: "openai-chat" }] }, "is a POST"],
    [{ passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat", per_request: 0.01 }] }, "priced by its models"],
    [
      { passthrough: [{ method: "POST", path: "a/chat", style: "openai-chat" }, { method: "POST", path: "b/chat", style: "openai-chat" }], pricing: PRICING },
      "one path per API style",
    ],
    [
      { passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }, { method: "POST", path: "v1/chat/{what}" }], pricing: PRICING },
      "custom.openai-chat",
    ],
    [
      { passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }, { method: "POST", path: "v1/chat/{x}", style: "openai-responses" }], pricing: PRICING },
      "can match the requests of the custom.",
    ],
    // The base URL holds `v1`, so `organization/{thing}` is an id path; a part where the endpoint name stands is not.
    [{ passthrough: [{ method: "GET", path: "{thing}/details" }] }, "only where an id is"],
    // It could take openai.transcription, and openai.speech, whose answers the transcription reader would misread.
    [{ baseUrl: "https://api.openai.com/", passthrough: [{ method: "POST", path: "v1/audio/{operation}", style: "openai-transcription" }], pricing: PRICING }, "openai.speech operation"],
    [{ baseUrl: "https://api.x.ai/", passthrough: [{ method: "POST", path: "v1/images/generations", style: "openai-images" }] }, "can report only their cost"],
    [{ baseUrl: "https://api.openai.com/v1%2Forganization/", passthrough: [{ method: "GET", path: "users" }] }, "encoded /"],
    [{ baseUrl: "https://llm.example.com/v1//chat/" }, "empty segment"],
    [{ baseUrl: "https://llm.example.com/v1/%E0%A4%A/" }, "broken percent-encoding"],
    [{ auth: { header: "x-end-user-id", format: "{key}" } }, "reads who is calling from it"],
    [{ auth: { header: "x-appattest-proof", format: "{key}" } }, "reads who is calling from it"],
    [
      { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }], pricing: { "local-llm": { input: 1, output: 2, modes: { us: { input: 1.1, output: 2.2 } } } } },
      "modes.us: no call on this connection is ever billed at this rate",
    ],
    [{ baseUrl: "https://llm.example.com/", passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", live_token: true }] }, "live_token"],
  ])("refuses %j", async (fields, message) => {
    const key = await seedManagementKey();
    const refused = await createCustom(key, fields);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
  });

  it("refuses an API style or a key header on a built-in provider", async () => {
    const key = await seedManagementKey();
    const base = { type: "openai", name: "OpenAI", secret: "sk-live-secret-abcd" };
    const styled = await admin(key, "POST", "/v2/admin/providers", { ...base, slug: "oa-styled", passthrough: [{ method: "POST", path: "v1/moderations", style: "openai-chat" }] });
    expect(styled.status).toBe(400);
    expect(JSON.stringify(styled.body)).toContain("only a custom provider's path names an API style");
    const auth = await admin(key, "POST", "/v2/admin/providers", { ...base, slug: "oa-auth", auth: AUTH });
    expect(auth.status).toBe(400);
  });

  it("is saved only with the manage grant, by an owner or admin", async () => {
    for (const options of [{ grant: "read" as const }, { role: "member" as const }]) {
      const key = await seedManagementKey(options);
      expect((await createCustom(key)).status, JSON.stringify(options)).toBe(403);
    }
  });

  it("judges its paths again when its base URL moves onto a known provider's host", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "POST", path: "v1/chat/completions" }] });
    expect(created.status).toBe(201);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://api.openai.com/", secret: SECRET });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("OpenAI's built-in openai.chat endpoint");
  });

  it("judges its paths again when its base URL moves onto a known provider's host with the same path", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { baseUrl: "https://llm.example.com/", passthrough: [{ method: "POST", path: "v1/chat/completions" }] });
    expect(created.status).toBe(201);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://api.openai.com/", secret: SECRET });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("OpenAI's built-in openai.chat endpoint");
  });

  it("refuses OpenRouter's built-in chat under its declared /api path on its plain origin: it would pass through unmetered", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { baseUrl: "https://openrouter.ai/", passthrough: [{ method: "POST", path: "api/v1/chat/completions" }] });
    expect(created.status).toBe(400);
    expect(JSON.stringify(created.body)).toContain("OpenRouter's built-in openrouter.chat endpoint");
    // Another of its paths is still listed.
    expect((await createCustom(key, { baseUrl: "https://openrouter.ai/", passthrough: [{ method: "GET", path: "api/v1/credits" }] })).status).toBe(201);
  });

  it("saves an admin path or a token mint on a known provider's host: the customer decides", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      baseUrl: "https://api.openai.com/",
      passthrough: [{ method: "POST", path: "v1/organization/admin_api_keys" }, { method: "POST", path: "v1/realtime/client_secrets" }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // A custom provider has no suggested defaults: only what its customer sets.
    expect(created.body.provider.passthrough).toEqual([
      { method: "POST", path: "v1/organization/admin_api_keys" },
      { method: "POST", path: "v1/realtime/client_secrets" },
    ]);
  });

  it("needs the key again to move to another base URL: a key is never sent to a new origin", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key);
    const moved = await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, baseUrl: "https://other.example.com/" });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toContain("needs the key");
  });

  it("answers a key test without sending anything: it has no call known to be free", async () => {
    const key = await seedManagementKey();
    const tested = await admin(key, "POST", "/v2/admin/providers/test", { type: "custom", secret: SECRET, baseUrl: BASE, auth: AUTH });
    expect(tested).toEqual({ status: 200, body: { validated: false, reason: "no_probe" } });
    expect((await admin(key, "POST", "/v2/admin/providers/test", { type: "custom", secret: SECRET, baseUrl: "https://localhost/" })).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets an app enable its style operations and passthrough, and judges the app's models on the connection's rates", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "GET", path: "models" }],
      pricing: PRICING,
    });
    const slug = created.body.provider.slug as string;
    const make = (models?: string[], operations = ["custom.openai-chat", "passthrough"]) =>
      admin(key, "POST", "/v2/admin/apps", {
        name: `Custom ${crypto.randomUUID().slice(0, 6)}`,
        config: {
          authentication: { type: "api_key", end_user: { source: "none" } },
          routing: { providers: { [slug]: { operations, ...(models === undefined ? {} : { models }) } } },
        },
      });
    expect((await make()).status).toBe(201);
    expect((await make(["local-llm"])).status).toBe(201);
    expect((await make(["not-priced"])).status).toBe(400);
    expect((await make(undefined, ["custom.openai-responses"])).status).toBe(400);
    expect((await make(undefined, ["openai.chat"])).status).toBe(400);
  });

  it("keeps saving an app whose unchanged route names a path's operation the provider no longer lists", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }], pricing: PRICING });
    const slug = created.body.provider.slug as string;
    const config = { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [slug]: { operations: ["custom.openai-chat"] } } } };
    const app = await admin(key, "POST", "/v2/admin/apps", { name: "Chat", config });
    expect(app.status).toBe(201);
    expect((await admin(key, "PUT", `/v2/admin/providers/${created.body.provider.id}`, { revision: 1, passthrough: [{ method: "GET", path: "models" }] })).status).toBe(200);
    const renamed = await admin(key, "PUT", `/v2/admin/apps/${app.body.app.id}`, { revision: app.body.app.revision, name: "Renamed", config });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
  });

  it("judges the calls a change makes reachable again: an API style re-listed for a model with no rate is refused", async () => {
    const key = await seedManagementKey();
    const chatPath = { method: "POST", path: "chat/completions", style: "openai-chat" };
    const created = await createCustom(key, { passthrough: [chatPath], pricing: PRICING });
    const id = created.body.provider.id as string;
    const slug = created.body.provider.slug as string;
    const config = {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["custom.openai-chat"], models: ["local-llm"] } } },
    };
    expect((await admin(key, "POST", "/v2/admin/apps", { name: "Chat", config })).status).toBe(201);
    // The style goes, then its model's rate: no call of the app reaches it, so both save.
    expect((await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, passthrough: [{ method: "GET", path: "models" }] })).status).toBe(200);
    expect((await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, pricing: { "other-llm": { input: 1, output: 2 } } })).status).toBe(200);
    // Listing the style again makes the app's call reachable with no rate.
    const back = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 3, passthrough: [chatPath] });
    expect(back.status, JSON.stringify(back.body)).toBe(400);
    expect(back.body.error.code).toBe("pricing_not_configured");
    // With its rate, it saves.
    expect((await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 3, passthrough: [chatPath], pricing: PRICING })).status).toBe(200);
  });

  it("judges a mode rate by the charge function, fallbacks included: a tier rate bills a regional host's calls", async () => {
    const key = await seedManagementKey();
    const fields = (baseUrl: string, modes: Record<string, unknown>) => ({
      baseUrl,
      passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }],
      pricing: { "some-model": { input: 1, output: 2, modes } },
    });
    // A `priority+eu` call with no `eu` rate bills the global `priority` rate, as an estimate: the rate is used.
    expect((await createCustom(key, fields("https://api.eu.mistral.ai/", { priority: { factor: 2 } }))).status).toBe(201);
    expect((await createCustom(key, fields("https://us.api.x.ai/", { priority: { input: 2, output: 4 } }))).status).toBe(201);
    // A long rate in a mode bills a call over the threshold.
    const long = await createCustom(key, {
      baseUrl: "https://us.api.x.ai/",
      passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }],
      pricing: { "some-model": { input: 1, output: 2, long_context_threshold: 100, modes: { priority: { long_input: 3 } } } },
    });
    expect(long.status, JSON.stringify(long.body)).toBe(201);
    // On a host with no region, no call is ever billed in one.
    const refused = await createCustom(key, fields(BASE, { us: { factor: 1.1 } }));
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("modes.us: no call on this connection is ever billed at this rate");
  });

  it("judges only the mode entries a save adds or changes: a stored one stays when only the standard rate changes", async () => {
    const key = await seedManagementKey();
    const created = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug: `oa-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-live-secret-abcd" });
    const id = created.body.provider.id as string;
    // As if stored by an earlier release: an `eu` rate a global connection never bills.
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?")
      .bind(JSON.stringify({ "gpt-4o-mini": { input: 150_000_000, output: 600_000_000, modes: { eu: { factor: 1.1 } } } }), id)
      .run();
    const changed = await admin(key, "PUT", `/v2/admin/providers/${id}`, {
      revision: 1,
      pricing: { "gpt-4o-mini": { input: 0.2, output: 0.6, modes: { eu: { factor: 1.1 } } } },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    // A changed `eu` entry is judged.
    const refused = await admin(key, "PUT", `/v2/admin/providers/${id}`, {
      revision: 2,
      pricing: { "gpt-4o-mini": { input: 0.2, output: 0.6, modes: { eu: { factor: 1.2 } } } },
    });
    expect(refused.status).toBe(400);
  });

  it("judges only mode rates a save adds or changes, never ones stored before", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }], pricing: PRICING });
    const id = created.body.provider.id as string;
    // As if stored by an earlier release.
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?")
      .bind(JSON.stringify({ "local-llm": { input: 1_000_000_000, output: 2_000_000_000, modes: { eu: { factor: 1.1 } } } }), id)
      .run();
    const kept = await admin(key, "PUT", `/v2/admin/providers/${id}`, {
      revision: 1,
      pricing: { "local-llm": { input: 1, output: 2, modes: { eu: { factor: 1.1 } } }, "other-llm": { input: 1, output: 2 } },
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  });

  it("needs the connection's rates for an xAI chat path: xAI's dollar report is never taken", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { baseUrl: "https://api.x.ai/", passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }] });
    expect(created.status).toBe(201);
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "xAI custom",
      config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [created.body.provider.slug]: { operations: ["custom.openai-chat"], models: ["grok-4"] } } } },
    });
    expect(app.status).toBe(400);
  });

  it("needs a rate for every answer a speech path can return: a plain audio answer is billed by characters", async () => {
    const key = await seedManagementKey();
    const speech = (pricing: Record<string, unknown>) => createCustom(key, { passthrough: [{ method: "POST", path: "audio/speech", style: "openai-speech" }], pricing });
    // Token rates alone price a streamed answer, never a plain audio one.
    const tokensOnly = await speech({ "gpt-4o-mini-tts": { input: 0.6, output: 12 } });
    expect(tokensOnly.status).toBe(400);
    expect(JSON.stringify(tokensOnly.body)).toContain("pricing.gpt-4o-mini-tts");
    const created = await speech({ "gpt-4o-mini-tts": { input: 0.6, output: 12, per_million_characters: 15 } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "Speech",
      config: {
        authentication: { type: "api_key", end_user: { source: "none" } },
        routing: { providers: { [created.body.provider.slug]: { operations: ["custom.openai-speech"], models: ["gpt-4o-mini-tts"] } } },
      },
    });
    expect(app.status, JSON.stringify(app.body)).toBe(201);
  });

  it("lets an app use chat and transcription on one custom provider: each model is judged on the path its price fits", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, {
      passthrough: [
        { method: "POST", path: "chat/completions", style: "openai-chat" },
        { method: "POST", path: "audio/transcriptions", style: "openai-transcription" },
      ],
      pricing: { llama: { input: 1, output: 2 }, whisper: { input: 1, output: 2, per_minute: 0.006 } },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "Chat and transcription",
      config: {
        authentication: { type: "api_key", end_user: { source: "none" } },
        routing: { providers: { [created.body.provider.slug]: { operations: ["custom.openai-chat", "custom.openai-transcription"] } } },
      },
    });
    expect(app.status, JSON.stringify(app.body)).toBe(201);
  });

  it("saves a transcription provider priced per minute alone, and an image provider priced per image alone", async () => {
    const key = await seedManagementKey();
    const transcription = await createCustom(key, {
      passthrough: [{ method: "POST", path: "audio/transcriptions", style: "openai-transcription" }],
      pricing: { whisper: { per_minute: 0.006 } },
    });
    expect(transcription.status, JSON.stringify(transcription.body)).toBe(201);
    const images = await createCustom(key, {
      passthrough: [{ method: "POST", path: "images/generations", style: "openai-images" }],
      pricing: { "flux-dev": { per_image: 0.025 } },
    });
    expect(images.status, JSON.stringify(images.body)).toBe(201);
    for (const [created, operation, model] of [
      [transcription, "custom.openai-transcription", "whisper"],
      [images, "custom.openai-images", "flux-dev"],
    ] as const) {
      const app = await admin(key, "POST", "/v2/admin/apps", {
        name: `${model} app`,
        config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [created.body.provider.slug]: { operations: [operation], models: [model] } } } },
      });
      expect(app.status, JSON.stringify(app.body)).toBe(201);
    }
  });

  it("names the measure a price lacks", async () => {
    const key = await seedManagementKey();
    const refused = await createCustom(key, { passthrough: [{ method: "POST", path: "audio/speech", style: "openai-speech" }], pricing: { tts: { input: 1, output: 2 } } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("it needs a rate for characters");
  });

  it("judges only what a save changes: a stored header or style a later rule refuses keeps saving", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { baseUrl: "https://api.x.ai/", passthrough: [{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }], pricing: PRICING });
    const id = created.body.provider.id as string;
    // As if stored by an earlier release, before these rules: a header the gateway reads, and xAI's image style.
    await env.DB.prepare("UPDATE provider_connection SET passthrough_json = ? WHERE id = ?")
      .bind(
        storedPassthrough(
          [
            { method: "POST", path: "v1/chat/completions", style: "openai-chat" },
            { method: "POST", path: "v1/images/generations", style: "openai-images" },
          ],
          { header: "x-end-user-id", format: "{key}" },
        ),
        id,
      )
      .run();
    const renamed = await admin(key, "PUT", `/v2/admin/providers/${id}`, {
      revision: 1,
      name: "Renamed",
      passthrough: [
        { method: "POST", path: "v1/chat/completions", style: "openai-chat" },
        { method: "POST", path: "v1/images/generations", style: "openai-images" },
        { method: "GET", path: "v1/models" },
      ],
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    // A new header is judged.
    expect((await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, auth: { header: "x-appattest-proof", format: "{key}" } })).status).toBe(400);
  });

  it("refuses a known host's declared path listed with another style, and names its own", async () => {
    const key = await seedManagementKey();
    const wrong = await createCustom(key, {
      baseUrl: "https://api.anthropic.com/",
      passthrough: [{ method: "POST", path: "v1/messages", style: "openai-chat" }],
      pricing: PRICING,
    });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toContain("list it with the style anthropic-messages");
    const right = await createCustom(key, {
      baseUrl: "https://api.anthropic.com/",
      passthrough: [{ method: "POST", path: "v1/messages", style: "anthropic-messages" }],
      pricing: PRICING,
    });
    expect(right.status, JSON.stringify(right.body)).toBe(201);
  });

  it("refuses a plain path that would take a known host's declared operation, and suggests its style", async () => {
    const key = await seedManagementKey();
    const refused = await createCustom(key, { baseUrl: "https://api.openai.com/", passthrough: [{ method: "POST", path: "v1/chat/completions" }] });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("list it with the style openai-chat");
    expect((await createCustom(key, { baseUrl: "https://api.openai.com/", passthrough: [{ method: "POST", path: "v1/moderations" }] })).status).toBe(201);
  });

  it("saves an API-style path with no rate yet: an app that routes it is judged when saved", async () => {
    const key = await seedManagementKey();
    const created = await createCustom(key, { passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }] });
    expect(created.status).toBe(201);
    const app = await admin(key, "POST", "/v2/admin/apps", {
      name: "Unpriced",
      config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [created.body.provider.slug]: { operations: ["custom.openai-chat"], models: ["local-llm"] } } } },
    });
    expect(app.status).toBe(400);
  });

  it("is never taken from a handoff: a custom provider is a person's choice", async () => {
    const key = await seedManagementKey();
    const handoff = await admin(key, "POST", "/v2/admin/provider-handoffs", { type: "custom", name: "Mine", baseUrl: BASE });
    expect(handoff.status).toBe(400);
  });
});

/** A custom connection stored as a save would store it, and an app routed to it. */
async function setup(
  paths: readonly { method: string; path: string; priceNano?: number; style?: string }[],
  operations: readonly string[],
  baseUrl = BASE,
  ratesJson: Record<string, unknown> = { "local-llm": { input: 1_000_000_000, output: 2_000_000_000 } },
  models?: readonly string[],
  auth: { header: string; format: string } = AUTH,
) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `custom-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "custom", baseUrl], SECRET);
  const rates = JSON.stringify(ratesJson);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, passthrough_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'custom', ?, 'Mine', 'active', ?, '9876', ?, ?, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, baseUrl, rates, storedPassthrough(paths as never, auth), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations, ...(models === undefined ? {} : { models }) } } },
  );
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function send(method: string, path: string, key: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

describe("serving a custom provider", () => {
  const paths = [
    { method: "POST", path: "chat/completions", style: "openai-chat" },
    { method: "GET", path: "models/{model}" },
  ];

  it("meters an API-style path by its usage reader at the connection's rates, with the key in the named header", async () => {
    const { appId, slug, key } = await setup(paths, ["custom.openai-chat"]);
    fetchSpy.mockResolvedValueOnce(
      Response.json({ id: "c1", choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }),
    );
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "local-llm", messages: [{ role: "user", content: "hi" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://llm.example.com/v1/chat/completions");
    const headers = new Headers(init!.headers);
    expect(headers.get("x-api-key")).toBe(`Key ${SECRET}`);
    // The app's own key never reaches the provider.
    expect(headers.get("authorization")).toBeNull();
    expect(init!.redirect).toBe("manual");
    expect(await chargesOf(appId)).toEqual([
      expect.objectContaining({ operation: "custom.openai-chat", provider_type: "custom", model: "local-llm", price_source: "customer_rate", cost_nano: 2_000_000 }),
    ]);
  });

  it("refuses a model the connection has no rate for, and sends nothing", async () => {
    const { appId, slug, key } = await setup(paths, ["custom.openai-chat"]);
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "other-model", messages: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes a plain listed path through, `not_priced`, only to an app that enables passthrough", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough"]);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "local-llm" }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/local-llm`, key);
    expect(response.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://llm.example.com/v1/models/local-llm");
    expect(await chargesOf(appId)).toEqual([expect.objectContaining({ operation: "passthrough", price_source: "not_priced" })]);
    // Passthrough alone does not reach the API-style path.
    const styled = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, { body: "{}", headers: { "content-type": "application/json" } });
    expect(styled.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a path it does not list", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough", "custom.openai-chat"]);
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/files`, key);
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never follows a redirect: the key stays with the base URL's host", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough"]);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://collector.example.net/steal" } }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, key);
    expect(response.status).toBe(307);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![1]!.redirect).toBe("manual");
  });

  it("bills the service tier the answer names, at the connection's rate in that mode", async () => {
    const { appId, slug, key } = await setup(paths, ["custom.openai-chat"], BASE, {
      "local-llm": { input: 1_000_000_000, output: 2_000_000_000, modes: { fast: { input: 2_000_000_000, output: 4_000_000_000 } } },
    });
    fetchSpy.mockResolvedValueOnce(
      Response.json({ id: "c1", service_tier: "priority", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }),
    );
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "local-llm", service_tier: "priority", messages: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ operation: "custom.openai-chat", cost_nano: 4_000_000 });
    expect(JSON.parse(String(charge!.measures_json))).toMatchObject({ service_mode: "fast" });
  });

  it("refuses a transcription format whose answer carries no measure, and sends nothing", async () => {
    const { appId, slug, key } = await setup([{ method: "POST", path: "audio/transcriptions", style: "openai-transcription" }], ["custom.openai-transcription"]);
    const form = new FormData();
    form.append("model", "local-llm");
    form.append("response_format", "text");
    form.append("file", new Blob([new Uint8Array(64)], { type: "audio/mpeg" }), "a.mp3");
    const { response, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/audio/transcriptions`, key, { body: form });
    expect(response.status, text).toBe(400);
    expect(text).toContain("response_format");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never reads the app key from a header the app reads its end user from, even when it is the provider's key header", async () => {
    const auth = clientAuth({ authentication: { type: "api_key", end_user: { source: "header", header: "x-user" } } } as never);
    const headers = new Headers({ "x-user": "agw_looks_like_a_key" });
    expect(() => requestCredential(headers, auth, "x-user")).toThrow(/access token is required/);
    expect(() => requestCredential(new Headers({ "x-end-user-id": "agw_x" }), auth, "x-end-user-id")).toThrow(/access token is required/);
    expect(requestCredential(new Headers({ "x-api-key": "agw_key" }), auth, "x-api-key")).toEqual({ token: "agw_key", headerName: "x-api-key" });
  });

  it("bills an xAI chat path at the connection's rate even when the answer reports its cost", async () => {
    const { appId, slug, key } = await setup([{ method: "POST", path: "v1/chat/completions", style: "openai-chat" }], ["custom.openai-chat"], "https://api.x.ai/");
    fetchSpy.mockResolvedValueOnce(
      Response.json({ id: "c1", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cost_in_usd_ticks: 999_000_000_000 } }),
    );
    const { response } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, {
      body: JSON.stringify({ model: "local-llm", messages: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await chargesOf(appId)).toEqual([expect.objectContaining({ price_source: "customer_rate", cost_nano: 2_000_000 })]);
  });

  it("judges a Vercel chat path's fallback models against the app's list, as Vercel's own connection does", async () => {
    const { appId, slug, key } = await setup(
      [{ method: "POST", path: "chat/completions", style: "openai-chat" }],
      ["custom.openai-chat"],
      "https://ai-gateway.vercel.sh/v1/",
      { "openai/gpt-4o-mini": { input: 150_000_000, output: 600_000_000 }, "openai/gpt-4o": { input: 2_500_000_000, output: 10_000_000_000 } },
      ["openai/gpt-4o-mini"],
    );
    const { response, text } = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [], providerOptions: { gateway: { models: ["openai/gpt-4o"] } } }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status, text).toBe(403);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends an image edit preset on a custom path as the upload it is", async () => {
    const rates = { "local-img": { input: 1_000_000_000, output: 2_000_000_000, per_image: 40_000_000 } };
    const { appId, slug, key } = await setup([{ method: "POST", path: "v1/images/edits", style: "openai-images" }], ["custom.openai-images"], BASE, rates);
    const stored = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(appId).first<{ config_json: string }>();
    const config = { ...JSON.parse(stored!.config_json), presets: { edit: { provider: slug, operation: "custom.openai-images", model: "local-img" } } };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), appId).run();
    fetchSpy.mockResolvedValueOnce(Response.json({ data: [{}], usage: { generated_images: 1 } }));
    const form = new FormData();
    form.append("prompt", "a hat");
    form.append("image", new Blob([new Uint8Array(32)], { type: "image/png" }), "a.png");
    const { response, text } = await send("POST", `/v2/apps/${appId}/presets/edit`, key, { body: form });
    expect(response.status, text).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://llm.example.com/v1/v1/images/edits");
    expect(init!.body).toBeInstanceOf(FormData);
    expect((init!.body as FormData).get("model")).toBe("local-img");
  });

  it("never passes the key header back to the app, in an answer or an error", async () => {
    const { appId, slug, key } = await setup(paths, ["passthrough", "custom.openai-chat"]);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "local-llm" }, { headers: { "x-api-key": `Key ${SECRET}` } }));
    const ok = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, key);
    expect(ok.response.status).toBe(200);
    expect(ok.response.headers.get("x-api-key")).toBeNull();
    fetchSpy.mockResolvedValueOnce(Response.json({ error: { message: "bad" } }, { status: 400, headers: { "x-api-key": `Key ${SECRET}` } }));
    const failed = await send("POST", `/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, {
      body: JSON.stringify({ model: "local-llm", messages: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(failed.response.status).toBe(400);
    expect(failed.response.headers.get("x-api-key")).toBeNull();
  });

  it("never passes a key header the upstream echoes back, such as x-request-id, whatever its case", async () => {
    const auth = { header: "x-request-id", format: "{key}" };
    const { appId, slug, key } = await setup(paths, ["passthrough"], BASE, undefined, undefined, auth);
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "local-llm" }, { headers: { "X-Request-Id": SECRET } }));
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, key, { headers: { "X-REQUEST-ID": "client-value" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeNull();
    // The provider got the key there, never the client's value.
    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get("x-request-id")).toBe(SECRET);
  });

  it("never gives a fallback on another host the client's value of the primary's key header", async () => {
    const chat = [{ method: "POST", path: "chat/completions", style: "openai-chat" }];
    const primary = await setup(chat, ["custom.openai-chat"], BASE, undefined, undefined, { header: "idempotency-key", format: "{key}" });
    const fallback = await setup(chat, ["custom.openai-chat"], "https://other.example.org/v1/");
    const stored = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(primary.appId).first<{ config_json: string }>();
    const config = {
      ...JSON.parse(stored!.config_json),
      presets: {
        chat: { provider: primary.slug, operation: "custom.openai-chat", model: "local-llm", fallback: [{ provider: fallback.slug, model: "local-llm" }] },
      },
    };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), primary.appId).run();
    fetchSpy
      .mockResolvedValueOnce(Response.json({ error: { message: "down" } }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "c1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const { response, text } = await send("POST", `/v2/apps/${primary.appId}/presets/chat`, primary.key, {
      body: JSON.stringify({ messages: [] }),
      headers: { "content-type": "application/json", "Idempotency-Key": "client-retry-1" },
    });
    expect(response.status, text).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [first, second] = fetchSpy.mock.calls.map(([url, init]) => ({ url: String(url), headers: new Headers(init!.headers) }));
    expect(first!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(first!.headers.get("idempotency-key")).toBe(SECRET);
    expect(second!.url).toBe("https://other.example.org/v1/chat/completions");
    expect(second!.headers.get("idempotency-key")).toBeNull();
    expect(second!.headers.get("x-api-key")).toBe(`Key ${SECRET}`);
  });

  it("drops a disabled preset target's key header from the client's request too", async () => {
    const chat = [{ method: "POST", path: "chat/completions", style: "openai-chat" }];
    const disabled = await setup(chat, ["custom.openai-chat"], BASE, undefined, undefined, { header: "idempotency-key", format: "{key}" });
    await env.DB.prepare("UPDATE provider_connection SET status = 'disabled' WHERE slug = ?").bind(disabled.slug).run();
    const fallback = await setup(chat, ["custom.openai-chat"], "https://other.example.org/v1/");
    const stored = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(disabled.appId).first<{ config_json: string }>();
    const config = {
      ...JSON.parse(stored!.config_json),
      presets: { chat: { provider: disabled.slug, operation: "custom.openai-chat", model: "local-llm", fallback: [{ provider: fallback.slug, model: "local-llm" }] } },
    };
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?").bind(JSON.stringify(config), disabled.appId).run();
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "c1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const { response, text } = await send("POST", `/v2/apps/${disabled.appId}/presets/chat`, disabled.key, {
      body: JSON.stringify({ messages: [] }),
      headers: { "content-type": "application/json", "IDEMPOTENCY-KEY": "client-retry-1" },
    });
    expect(response.status, text).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://other.example.org/v1/chat/completions");
    expect(new Headers(fetchSpy.mock.calls[0]![1]!.headers).get("idempotency-key")).toBeNull();
  });

  it("checks who is calling first: a custom path needs a valid app key", async () => {
    const { appId, slug } = await setup(paths, ["passthrough"]);
    const { response } = await send("GET", `/v2/apps/${appId}/proxy/${slug}/models/x`, "agw_not_a_real_key");
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
