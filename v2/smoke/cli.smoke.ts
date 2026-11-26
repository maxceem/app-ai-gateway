/**
 * agw 2 against a live v2 deployment (step 2e), run from its sources with a
 * management key from the environment and state of its own:
 *
 * - `deployment connect` checks the key and stores no credential;
 * - a gateway command, built from the tool list, lists the apps;
 * - the built-in `app add`, `app update` and the gateway's `app remove`
 *   change a throwaway iOS app, which is removed again.
 *
 *   V2_CONSOLE_URL=https://console.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Skipped without both. Nothing is left behind.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admin, assertHolds, check, checkId, cleanUp, expectCli, expectResponse, expectStatus, fail, note, readJson, REQUEST_TIMEOUT_MS, same, send, TEST_TIMEOUT_MS, uniqueSlug } from "./support.ts";

const consoleUrl = process.env.V2_CONSOLE_URL ?? "";
const managementKey = process.env.V2_MANAGEMENT_KEY ?? "";
const skip = consoleUrl === "" || managementKey === "" ? "V2_CONSOLE_URL and V2_MANAGEMENT_KEY are needed" : false;
const bin = fileURLToPath(new URL("../cli/src/bin.ts", import.meta.url));

/** The console's origin; a `V2_CONSOLE_URL` that is not a URL fails with fixed text, never itself. */
function consoleOrigin(): string {
  try {
    return new URL(consoleUrl).origin;
  } catch {
    fail("V2_CONSOLE_URL is not a URL");
  }
}

/**
 * One `agw` run with `--json`, given up after `REQUEST_TIMEOUT_MS`, its
 * document parsed. A run that cannot start or prints no document fails with
 * fixed text: never its arguments, which hold ids read from the deployment,
 * or its output.
 */
function agw(home: string, ...argv: string[]): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv, "--json"], {
      // Only what agw needs, as v1's check gives it: its state and cache in this run's own
      // directory on every system (Windows reads LOCALAPPDATA), and nothing else from this
      // process's environment.
      // (Cast: the Worker's generated types make its secrets required on `ProcessEnv`, and a
      // child's environment must hold none of them.)
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        LOCALAPPDATA: join(home, "local"),
        NO_COLOR: "1",
        AGW_MANAGEMENT_KEY: managementKey,
      } as Record<string, string> as NodeJS.ProcessEnv,
      // Never read, so never piped: a full pipe would stall the run.
      stdio: ["ignore", "pipe", "ignore"],
      timeout: REQUEST_TIMEOUT_MS,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => reject(new Error("agw could not start")));
    child.on("close", (code) => {
      try {
        resolve({ code: code ?? 1, json: JSON.parse(out) });
      } catch {
        reject(new Error("agw printed no JSON document"));
      }
    });
  });
}

test("agw 2 connects with a management key and manages an app", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  let created: string | undefined;
  try {
    const connected = await agw(home, "deployment", "connect", "--url", consoleOrigin());
    expectCli(connected, "agw connected");
    same(connected.json.result.credential, "environment", "connected.json.result.credential is not \"environment\"");

    const listed = await agw(home, "app", "list");
    expectCli(listed, "agw listed");
    check(Array.isArray(listed.json.result.apps), "Array.isArray(listed.json.result.apps)");

    const added = await agw(home, "app", "add", "--type", "ios", "--name", "agw smoke", "--team-id", "ABCDE12345", "--bundle-id", "com.example.agwsmoke");
    expectCli(added, "agw added");
    created = checkId(added.json.result?.app?.id, "the app agw added");
    // An iOS app has no app key: say so without ever printing one that came back.
    check(added.json.result.key === null, "agw app add returned an app key for an iOS app");

    const paused = await agw(home, "app", "update", created, "--status", "disabled");
    expectCli(paused, "agw paused");
    same(paused.json.result.app.status, "disabled", "paused.json.result.app.status is not \"disabled\"");
  } finally {
    // The remote clean-up and the local one each run, whatever the other did.
    try {
      const id = created;
      await cleanUp(
        id === undefined
          ? []
          : [
              async () => {
                const removed = await agw(home, "app", "remove", id, "--yes");
                return { status: removed.code === 0 ? 200 : 500 };
              },
            ],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("agw 2 lists provider types, adds an iOS app with the settings its flags name, and shows its first requests", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  let created: string | undefined;
  try {
    expectCli(await agw(home, "deployment", "connect", "--url", consoleOrigin()), "agw connected");
    const types = await agw(home, "provider", "types");
    expectCli(types, "agw provider types");
    const openai = types.json.result.types.find((entry: { type: string }) => entry.type === "openai");
    check(Array.isArray(openai?.operations) && openai.operations.includes("openai.chat"), "agw provider types names no openai.chat operation");

    const added = await agw(
      home, "app", "add", "--type", "ios", "--name", "agw smoke flags", "--team-id", "ABCDE12345", "--bundle-id", "com.example.agwsmokeflags",
      "--attest-environments", "production,development", "--verify-on", "token_exchange", "--status", "disabled",
    );
    expectCli(added, "agw added with flags");
    created = checkId(added.json.result?.app?.id, "the app agw added with flags");
    same(added.json.result.app.status, "disabled", "the app agw added is not disabled");
    const attest = added.json.result.app.config.authentication.app_attest;
    same(attest.environments, ["production", "development"], "the app's environments are not the ones named");
    same(attest.verify_on, "token_exchange", "the app's verify_on is not token_exchange");

    const snippet = await agw(home, "app", "snippet", created);
    expectCli(snippet, "agw app snippet");
    // The app was added disabled: nothing to run, and the note says why.
    check(Array.isArray(snippet.json.result.examples) && snippet.json.result.examples.length === 0, "agw app snippet gave a disabled app examples");
    check(snippet.json.result.notes.some((line: string) => line.startsWith("This app is disabled")), "agw app snippet did not say the app is disabled");

    const resumed = await agw(home, "app", "update", created, "--status", "active");
    expectCli(resumed, "agw turned the app on");
    const active = await agw(home, "app", "snippet", created);
    expectCli(active, "agw app snippet for the active app");
    check(active.json.result.notes.some((line: string) => line.includes("Swift SDK")), "agw app snippet did not point an iOS app to the Swift SDK");
  } finally {
    try {
      const id = created;
      await cleanUp(
        id === undefined
          ? []
          : [
              async () => {
                const removed = await agw(home, "app", "remove", id, "--yes");
                return { status: removed.code === 0 ? 200 : 500 };
              },
            ],
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

const base = process.env.V2_BASE_URL ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const skipRoundTrip = skip !== false ? skip : base === "" || mockUrl === "" ? "V2_BASE_URL and V2_MOCK_URL are needed" : false;

/** A public key for the issuer settings below. Saving never fetches it. */
const JWK = "eyJrdHkiOiJFQyIsImNydiI6IlAtMjU2IiwieCI6ImY4M09KM0QyeEYxQmc4dnViOXRMZTFnSE16Vjc2ZThUdXM5dVBIdlJWRVUiLCJ5IjoieF9GRXpSdTltMzZITE5fdHVlNjU5TE5wWFc2cEN5U3Rpa1lqS0lXSTVhMCIsImtpZCI6InNtb2tlLTEiLCJhbGciOiJFUzI1NiJ9";

/**
 * Every optional app setting a released `agw` must read and write back
 * intact, each set away from its default (v1's `EVERY_OPTION`). A release
 * that adds an optional app setting adds it here too: these are what
 * published CLIs are asked to keep.
 */
/**
 * Conversation storage in the round trip: `absent` on a deployment from before
 * it (whose stricter schema refuses the block), `off` where the deployment or
 * the plan does not offer storing (the retention settings are still written
 * and must survive), and `on` where it does.
 */
type Storage = "absent" | "off" | "on";

function everyOption(slug: string, mock: string, storage: Storage): Record<string, unknown>[] {
  const issuer = {
    jwks_url: `${mock}jwks/${JWK}`,
    issuer: ["https://smoke.app-ai-gateway.invalid"],
    audience: ["app-ai-gateway-smoke"],
    user_id_claim: "sub",
    token_header: "x-smoke-user-token",
    required_claims: [
      { path: "plan", equals: "pro" },
      { path: "roles", contains: ["pro"] },
    ],
    max_token_lifetime_seconds: 3600,
    provider: "custom",
    entitlement: "custom",
  };
  const routing = {
    providers: { [slug]: { operations: ["openai.chat", "openai.responses"], models: ["gpt-4o-mini"], max_output_tokens: 512 } },
    model_rewrites: { "smoke-alias": "gpt-4o-mini" },
  };
  const presets = {
    "smoke-preset": {
      provider: slug,
      operation: "openai.chat",
      model: "gpt-4o-mini",
      params: { temperature: 0 },
      max_output_tokens: 256,
      fallback: [{ provider: slug, operation: "openai.chat", model: "gpt-4o-mini" }],
    },
  };
  // Each away from its default: every kind is kept, and kept 180 days, by default
  // (`CONVERSATION_RETENTION_DAYS` in `src/contracts/app-config.ts`). Storing (off by default) is
  // turned on only where the deployment and the plan offer it (see below).
  const conversations =
    storage === "absent" ? {} : { conversations: { store: storage === "on", keep: { images: false, audio: false, files: false }, retention_days: 30 } };
  return [
    {
      authentication: { type: "api_key", end_user: { source: "issuer", issuer } },
      routing,
      limits: {
        // A server app's budget can only be per user: the scope is still written, so it must survive.
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "user" } },
        per_app: { requests: { per_minute: 600, per_day: 20_000 }, spending: { monthly_nano: 50_000_000_000 }, sessions: { conversational: 4, streaming: 20 } },
      },
      presets,
      ...conversations,
    },
    {
      authentication: {
        type: "apple_app_attest",
        end_user: { source: "issuer", issuer },
        app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.agwsmoke", environments: ["production", "development"], verify_on: "token_exchange" },
      },
      routing,
      limits: {
        // An iOS app's budget is per Apple Account by default: per install is away from it.
        per_user: { requests: { per_minute: 30, per_day: 1000 }, spending: { monthly_nano: 5_000_000_000, scope: "install" } },
        per_app: { requests: { per_minute: 600, per_day: 20_000 }, spending: { monthly_nano: 50_000_000_000 }, sessions: { conversational: 4, streaming: 20 } },
      },
      presets,
      ...conversations,
    },
  ];
}

test("agw 2 reads an app with every option set whole, renames it without losing a setting, and the whole app written back keeps every setting; model list runs", { skip: skipRoundTrip, timeout: TEST_TIMEOUT_MS }, async () => {
  const home = await mkdtemp(join(tmpdir(), "agw-smoke-"));
  const slug = uniqueSlug("smoke-cli");
  const mock = mockUrl.endsWith("/") ? mockUrl : `${mockUrl}/`;
  let providerId = "";
  const created: string[] = [];
  try {
    const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: "Smoke CLI", slug, secret: "sk-mock-smoke-key", baseUrl: mock });
    expectStatus(provider, 201, "provider");
    providerId = checkId(provider.body.provider?.id, "the provider");
    const connected = await agw(home, "deployment", "connect", "--url", consoleOrigin());
    expectCli(connected, "agw connected");

    // The price list itself, as v1's check reads it: a known provider, and a number for a known model.
    const models = await agw(home, "model", "list");
    expectCli(models, "agw models");
    const prices = (models.json.result as { prices?: Record<string, Record<string, { input?: unknown }>> } | null)?.prices;
    check(prices?.openai, "agw model list gave no OpenAI prices");
    same(typeof prices.openai["gpt-4o-mini"]?.input, "number", "typeof prices.openai[\"gpt-4o-mini\"]?.input is not \"number\"");

    // Conversation storage is optional: a deployment without a CONVERSATIONS bucket, or a plan
    // without it, refuses an app that turns it on. The round trip runs either way; storing is
    // exercised where it is offered.
    // A deployment from before conversation storage has no capability field (or no capabilities
    // at all): the block is left out, since its schema refuses it.
    // Only a missing route (404) or a missing field means such a deployment: any other answer
    // fails, so a broken endpoint never passes with less covered.
    // Asked of the console's host, where agw connects and the other checks ask too.
    const capabilities = await send("/v2/console/capabilities", consoleOrigin());
    let offered: unknown;
    if (capabilities.status === 404) {
      await capabilities.body?.cancel();
    } else {
      await expectResponse(capabilities, 200, "the capabilities");
      const body = (await readJson(capabilities)) as { billing?: unknown; conversationStorage?: unknown } | null;
      // Every deployment that has capabilities answers with an object holding `billing`:
      // anything else (null, an array, an error) is a broken endpoint, not an older one.
      check(
        typeof body === "object" && body !== null && !Array.isArray(body) && typeof body.billing === "boolean",
        "the capabilities are not a capabilities object",
      );
      offered = body.conversationStorage;
      check(offered === undefined || typeof offered === "boolean", "the capabilities' conversationStorage is not a boolean");
    }
    let storage: Storage = offered === undefined ? "absent" : offered ? "on" : "off";
    for (const index of [0, 1]) {
      let config = everyOption(slug, mock, storage)[index]!;
      let app = await admin("POST", "/v2/admin/apps", { name: `agw smoke every option ${index}`, config });
      if (storage === "on" && app.status === 403 && app.body?.error?.code === "billing_feature_not_included") {
        storage = "off";
        config = everyOption(slug, mock, storage)[index]!;
        app = await admin("POST", "/v2/admin/apps", { name: `agw smoke every option ${index}`, config });
      }
      if (index === 0) {
        if (storage === "on") note("conversation storage in the round trip: on");
        else if (storage === "off") note("conversation storage in the round trip: off");
        else note("conversation storage in the round trip: absent");
      }
      expectStatus(app, 201, "app");
      const id = checkId(app.body.app?.id, "the app");
      created.push(id);
      // The baseline: what the server saved, checked to hold every value the fixture set,
      // so a setting dropped on creation is not compared against itself below.
      const before = await admin("GET", `/v2/admin/apps/${id}`);
      expectStatus(before, 200, "before");
      assertHolds(before.body.app.config, config, "the saved config does not hold every fixture value");
      const baseline = before.body.app.config;
      // What agw reads before it writes: `agw app show` gives the baseline, whole.
      const shown = await agw(home, "app", "show", id);
      expectCli(shown, "agw shown");
      same(shown.json.result?.app?.config, baseline, "the config agw app show printed is not the saved one");
      // `agw app update --name` sends only the new name (a JSON Patch): the server must keep every
      // setting it was not asked to change, and agw must print them all back.
      const renamed = await agw(home, "app", "update", id, "--name", `agw smoke every option ${index} renamed`);
      expectCli(renamed, "agw renamed");
      same(renamed.json.result?.app?.name, `agw smoke every option ${index} renamed`, "agw app update did not print the new name");
      same(renamed.json.result?.app?.config, baseline, "the config agw app update printed is not the saved one");
      const after = await admin("GET", `/v2/admin/apps/${id}`);
      expectStatus(after, 200, "after");
      same(after.body.app.name, `agw smoke every option ${index} renamed`, "the app name did not change after the rename");
      same(after.body.app.config, baseline, "the config after the rename is not the saved one");
      // The whole document written back as `agw app show` printed it (PUT, as v1's `agw app replace`
      // and any client that edits a saved app file do): every setting survives the round trip.
      const reread = await agw(home, "app", "show", id);
      expectCli(reread, "agw reread");
      const printed = reread.json.result?.app as { name: unknown; config: unknown; status: unknown; revision: unknown } | undefined;
      check(printed !== undefined, "agw app show printed no app");
      const replaced = await admin("PUT", `/v2/admin/apps/${id}`, { name: printed.name, config: printed.config, status: printed.status, revision: printed.revision });
      expectStatus(replaced, 200, "the whole app written back");
      const final = await admin("GET", `/v2/admin/apps/${id}`);
      expectStatus(final, 200, "final");
      same(final.body.app.config, baseline, "the config after the whole app was written back is not the saved one");
    }
  } finally {
    // The remote clean-up and the local one each run, whatever the other did.
    try {
      await cleanUp([
        ...created.map((id) => () => admin("DELETE", `/v2/admin/apps/${id}?confirm=${id}`)),
        ...(providerId === "" ? [] : [() => admin("DELETE", `/v2/admin/providers/${providerId}`)]),
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});
