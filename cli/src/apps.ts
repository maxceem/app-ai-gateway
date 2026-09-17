import { createHash } from "node:crypto";
import { AppWriteSchema, type AppWrite } from "../../src/contracts/schemas.ts";
import { operations } from "../../src/contracts/operations.ts";
import type {
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  AppDeleteResponse,
  AppListResponse,
  AppResponse,
  AppValidateResponse,
  CreatedApiKey,
  ProviderSummary,
} from "../../src/contracts/responses.ts";
import { fail, validate } from "./common.ts";
import type { Context, KeyOutput } from "./context.ts";
import { confirm } from "./input.ts";
import type { Flags } from "./parser.ts";
import { flagList } from "./parser.ts";
import { jsonFile, required } from "./resources.ts";
import { reserveOutput, type ReservedOutput, type StoredKeyMetadata } from "./state.ts";
import {
  curlSnippet,
  exampleNotes,
  firstRequest,
  shellQuote,
  swiftSnippet,
  type RequestExample,
} from "../../src/shared/first-request.ts";

const unlimited = () => ({
  requests: { per_minute: null, per_day: null },
  spending: { monthly_usd: null },
});
/**
 * The policy a newly selected provider starts with: unrestricted.
 *
 * Empty, never `["*"]`. Neither field takes a wildcard — `allowed_paths`
 * compiles each entry to an anchored pattern whose only placeholder is
 * `{model}`, and `allowed_models` is matched with `includes`, so a literal
 * `"*"` matches nothing and an empty list is what means "allow everything".
 * A saved `"*"` is also refused outright, because the gateway prices every
 * model an application names and no catalog prices a model called `*`.
 */
const policy = () => ({ allowed_paths: [] as string[], allowed_models: [] as string[] });

/** What a local or remote configuration check was able to establish. */
export type ValidationResult =
  | { local: true; remote: false; skipped: string[] }
  | ({ local: true; remote: true } & AppValidateResponse);

export interface AppWriteResult {
  snippet?: string;
  app: AppResponse["app"];
  resolved: AppResponse["resolved"];
  config_error: AppResponse["config_error"];
  applicationKey?: StoredKeyMetadata;
  guidance: string;
}

export interface AppCheckResult {
  appId: string;
  validation: ValidationResult;
  status: AppWrite["status"];
  providers: { id: string; slug: string; status: ProviderSummary["status"] }[];
  ready: boolean;
  limitations: string[];
}

export type AppResult =
  | AppListResponse
  | AppResponse
  | AppDeleteResponse
  | ApiKeyListResponse
  | ApiKeyRevokeResponse
  | AppWriteResult
  | AppCheckResult
  | { definition: AppWrite; validation: ValidationResult }
  | { dryRun: true; definition: AppWrite; validation: ValidationResult }
  | { appId: string; applicationKey: StoredKeyMetadata }
  | { output: string }
  | { language: "swift" | "shell"; snippet: string; notes: string[] };

/**
 * The stored application as a write body.
 *
 * Validated rather than copied: the read response admits a configuration that
 * predates a schema change (see `config_error`), and every command that reaches
 * for `config.authentication` needs one that parses. The refusal names the
 * field, which is what an operator repairing such a row needs.
 */
export function documentOf(app: AppResponse["app"]): AppWrite {
  return localApp({ name: app.name, config: app.config, status: app.status });
}

export function localApp(value: unknown): AppWrite {
  const doc = validate(AppWriteSchema, value);
  const auth = doc.config.authentication;
  if (auth.type === "apple_app_attest") {
    if (!/^[A-Z0-9]{10}$/.test(auth.app_attest.team_id))
      fail(
        "invalid_input",
        "App Attest team_id must contain ten uppercase letters or digits.",
      );
    if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(auth.app_attest.bundle_id))
      fail(
        "invalid_input",
        "App Attest bundle_id must be a reverse DNS identifier.",
      );
  }
  if (
    auth.type === "api_key" &&
    !auth.end_user &&
    doc.config.limits?.per_user &&
    (doc.config.limits.per_user.requests.per_minute !== null ||
      doc.config.limits.per_user.requests.per_day !== null ||
      doc.config.limits.per_user.spending.monthly_usd !== null)
  )
    fail("invalid_input", "User limits require an end-user identity source.");
  return doc;
}

export async function appDocument(flags: Flags, current?: AppWrite): Promise<AppWrite> {
  if (flags.file) {
    const permitted = new Set([
      "file",
      "json",
      "no-input",
      "dry-run",
      "key-output",
    ]);
    if (Object.keys(flags).some((k) => !permitted.has(k)))
      fail(
        "conflicting_flags",
        "--file replaces all application configuration flags.",
      );
    const doc = localApp(await jsonFile(flags.file));
    if (
      current &&
      doc.config.authentication.type !== current.config.authentication.type
    )
      fail("app_type_immutable", "Application type cannot change.");
    return doc;
  }
  let doc: AppWrite;
  if (current) doc = structuredClone(current);
  else {
    const type = await required(flags, "type", "App type (ios or server)");
    if (!["ios", "server"].includes(type))
      fail("invalid_input", "App type must be ios or server.");
    const ios = type === "ios";
    if (
      !ios &&
      ["team-id", "bundle-id", "attest-environments"].some((k) => flags[k as keyof Flags])
    )
      fail("invalid_input", "Server apps cannot use iOS flags.");
    const bundle = ios
      ? await required(flags, "bundle-id", "Apple bundle ID")
      : null;
    doc = localApp({
      name:
        flags.name ??
        (ios && bundle
          ? bundle.split(".").slice(-2).join(" ")
          : await required(flags, "name", "App name")),
      status: flags.status ?? "active",
      config: {
        authentication: ios
          ? {
              type: "apple_app_attest",
              end_user: { source: "app_install" },
              app_attest: {
                team_id: await required(flags, "team-id", "Apple team ID"),
                bundle_id: bundle,
                environments: (
                  flags["attest-environments"] ?? "production,development"
                ).split(","),
              },
            }
          : { type: "api_key" },
        routing: { providers: { mode: "all" }, model_rewrites: {} },
        ...(ios
          ? {
              limits: {
                per_user: {
                  requests: { per_minute: 10, per_day: 300 },
                  spending: { monthly_usd: null },
                },
                per_app: unlimited(),
              },
            }
          : {}),
      },
    });
  }
  if (flags.name) doc.name = flags.name;
  if (flags.status) doc.status = flags.status === "disabled" ? "disabled" : "active";
  const auth = doc.config.authentication;
  if (
    auth.type === "api_key" &&
    ["team-id", "bundle-id", "attest-environments"].some((k) => flags[k as keyof Flags])
  )
    fail("invalid_input", "Server apps cannot use iOS flags.");
  if (auth.type === "apple_app_attest") {
    if (flags["key-output"])
      fail("invalid_input", "iOS apps cannot export a server application key.");
    if (flags["team-id"]) auth.app_attest.team_id = flags["team-id"];
    if (flags["bundle-id"]) auth.app_attest.bundle_id = flags["bundle-id"];
    if (flags["attest-environments"])
      auth.app_attest.environments = flags["attest-environments"]
        .split(",")
        .map((value) => (value === "development" ? "development" : "production"));
  }
  const selectedProviders = flagList(flags.provider);
  if (selectedProviders.length) {
    const previous = doc.config.routing.providers.selected ?? {};
    doc.config.routing.providers = {
      mode: "selected",
      selected: Object.fromEntries(
        selectedProviders.map((slug) => [slug, previous[slug] ?? policy()]),
      ),
    };
  }
  if (flags["all-providers"]) doc.config.routing.providers = { mode: "all" };
  return localApp(doc);
}

async function remoteValidation(
  ctx: Context,
  doc: AppWrite,
  id = "validation-preview",
): Promise<ValidationResult> {
  if (!ctx.active?.credential)
    return {
      local: true,
      remote: false,
      skipped: [
        "Provider references, pricing, and saved configuration checks require login.",
      ],
    };
  const { data } = await ctx.call("validateApp", [id], { body: doc });
  return { local: true, remote: true, ...data };
}

/**
 * The plaintext key a creation just minted, if this run is the one that minted
 * it. A replayed creation answers with the redacted copy protected state keeps,
 * which carries no key at all — that is the point of it — and the command
 * reports its recorded `keyMetadata` instead.
 */
function mintedKey(
  value: CreatedApiKey | Omit<CreatedApiKey, "key"> | null,
): CreatedApiKey | null {
  return value && "key" in value ? value : null;
}

export async function saveKey(
  ctx: Context,
  keyRecord: CreatedApiKey,
  output: ReservedOutput | KeyOutput,
  appId: string,
): Promise<StoredKeyMetadata> {
  const raw = keyRecord.key;
  const recoverable = "recoveryAvailable" in output ? output : undefined;
  try {
    await output.write(raw + "\n");
  } catch {
    if (recoverable?.recoveryAvailable()) {
      await output.cancel();
      fail("key_output_pending", "The active key is saved in protected CLI recovery state, but its chosen output could not be completed.",
        "Retry the same command to finish the reserved output, or choose a new --key-output path. No new key will be generated.", 4, { appId, keyId: keyRecord.id, storagePath: output.path });
    }
    let revoked = false;
    try {
      await ctx.call("revokeAppKey", [appId, keyRecord.id]);
      revoked = true;
    } catch {
      /* Left unverified on purpose; the refusal below says so. */
    }
    if (recoverable) {
      recoverable.mutation.failure = { appId, keyId: keyRecord.id, revoked };
      delete recoverable.mutation.response;
      await ctx.save().catch(() => {});
    }
    await output.cancel();
    fail(
      "key_storage_failed",
      revoked
        ? "The key could not be stored and was revoked."
        : "The key could not be stored; revocation could not be verified.",
      `Inspect agw app key list ${appId}; revoke key ${keyRecord.id} before retrying.`,
      4,
      { appId, keyId: keyRecord.id, revoked },
    );
  }
  return {
    id: keyRecord.id,
    name: keyRecord.name,
    key_prefix: keyRecord.key_prefix,
    created_at: keyRecord.created_at,
    storagePath: output.path,
    contentHash: createHash("sha256").update(raw + "\n").digest("hex"),
  };
}

export async function appCommand(
  ctx: Context,
  command: string,
  args: string[],
  flags: Flags,
): Promise<AppResult> {
  const action = command.slice(4);
  if (action === "list") return (await ctx.call("listApps", [])).data;
  if (action === "validate") {
    const doc = localApp(await jsonFile(await required(flags, "file")));
    return { definition: doc, validation: await remoteValidation(ctx, doc) };
  }
  if (action === "add" || action === "update") {
    let current: AppWrite | undefined;
    // The revision the edit is made against, read from the application itself.
    // It travels back in the write body: a deployment sits behind a CDN that
    // rewrites response headers, so the resource is the only channel that
    // carries it intact.
    let revision = 0;
    const appId = args[0] ?? "";
    if (action === "update") {
      const r = await ctx.call("getApp", [appId]);
      current = documentOf(r.data.app);
      revision = r.data.app.revision;
      if (!revision && !flags["dry-run"])
        fail(
          "concurrency_unavailable",
          "The deployment does not report application revisions.",
          "Update the deployment before modifying an application.",
          3,
        );
      if (
        !Object.keys(flags).some(
          (k) => !["json", "no-input", "dry-run"].includes(k),
        )
      )
        fail("invalid_input", "Provide at least one application change.");
    }
    const doc = await appDocument(flags, current);
    if (flags["key-output"] && doc.config.authentication.type !== "api_key")
      fail("invalid_input", "--key-output only applies to server apps.");
    if (flags["dry-run"])
      return {
        dryRun: true,
        definition: doc,
        validation: await remoteValidation(ctx, doc, appId || undefined),
      };
    const output =
      action === "add" && doc.config.authentication.type === "api_key"
        ? await ctx.keyOutput(operations.createApp.path(), doc, flags["key-output"])
        : null;
    try {
      let app: AppResponse["app"];
      let resolved: AppResponse["resolved"];
      let configError: AppResponse["config_error"];
      let key: StoredKeyMetadata | undefined;
      if (action === "add") {
        await ctx.bootstrap();
        const created = await ctx.create("createApp", [], doc);
        ({ app, resolved, config_error: configError } = created.data);
        if (output) {
          if (created.keyMetadata) key = created.keyMetadata;
          else {
            const minted = mintedKey(created.data.api_key);
            if (!minted)
              fail(
                "invalid_response",
                "The server did not return the generated application key.",
                "Inspect the app key list before retrying.",
                3,
              );
            key = await saveKey(ctx, minted, output, app.id);
          }
          await created.keyStored?.(key);
        }
        await created.complete();
      } else {
        const updated = await ctx.call("updateApp", [appId], {
          body: { ...doc, revision },
        });
        ({ app, resolved, config_error: configError } = updated.data);
      }
      // The request this application can now send, written against whatever it
      // has: a provider it can reach and a priced model where those exist, and
      // named placeholders where they do not, so a first application is never
      // left to compose its first call from the reference.
      let snippet: string | undefined;
      try {
        const example = await appCommand(ctx, "app snippet", [app.id], {});
        if ("snippet" in example) snippet = example.snippet;
      } catch {
        /* A successful app creation remains successful when an example is unavailable. */
      }
      // The key itself is never printed. This reads the file the CLI has just
      // written, which is the one place it exists.
      if (snippet && key)
        snippet = `export APP_AI_GATEWAY_KEY="$(cat ${shellQuote(key.storagePath)})"\n\n${snippet}`;
      return {
        ...(snippet ? { snippet } : {}),
        app,
        resolved,
        config_error: configError,
        ...(key ? { applicationKey: key } : {}),
        guidance:
          doc.config.authentication.type === "apple_app_attest"
            ? `Add https://github.com/maxceem/app-ai-gateway-swift from 1.0.0, enable App Attest, and test on a supported physical device. Run agw app snippet ${app.id} --provider <slug> for integration code. Production releases should use production-only App Attest.`
            : `Store the generated key on your server; never embed it in a mobile application. Run agw app snippet ${app.id} for this request again.`,
      };
    } finally {
      await output?.cancel();
    }
  }
  if (action.startsWith("key ")) {
    const sub = action.slice(4);
    const appId = args[0] ?? "";
    const { data: app } = await ctx.call("getApp", [appId]);
    if (documentOf(app.app).config.authentication.type !== "api_key")
      fail(
        "invalid_input",
        "Only server applications support application keys.",
      );
    if (sub === "list") return (await ctx.call("listAppKeys", [appId])).data;
    if (sub === "revoke") {
      const keyId = args[1] ?? "";
      await confirm(
        `Revoke key ${keyId} for app ${appId}? Clients using it will lose access.`,
        flags,
      );
      return (await ctx.call("revokeAppKey", [appId, keyId])).data;
    }
    const name = await required(flags, "name");
    if (!name.trim() || name.length > 100)
      fail("invalid_input", "Key name must be 1–100 characters.");
    const output = await ctx.keyOutput(
      operations.createAppKey.path(appId),
      { name },
      flags["key-output"],
    );
    try {
      const created = await ctx.create("createAppKey", [appId], { name });
      let applicationKey = created.keyMetadata;
      if (!applicationKey) {
        const minted = mintedKey(created.data);
        if (!minted)
          fail(
            "invalid_response",
            "The server did not return the generated application key.",
            "Inspect the app key list before retrying.",
            3,
          );
        applicationKey = await saveKey(ctx, minted, output, appId);
      }
      await created.keyStored?.(applicationKey);
      await created.complete();
      return { appId, applicationKey };
    } finally {
      await output.cancel();
    }
  }
  const appId = args[0] ?? "";
  const { data } = await ctx.call("getApp", [appId]);
  if (action === "show") return data;
  const doc = documentOf(data.app);
  if (action === "remove") {
    await confirm(
      `Delete app ${data.app.name} (${appId})? Its keys, users and authentication state will be removed and clients will lose access.`,
      flags,
    );
    return (await ctx.call("deleteApp", [appId])).data;
  }
  if (action === "check") {
    const validation = await remoteValidation(ctx, doc, appId);
    const { data: providers } = await ctx.call("listProviders", []);
    const selected =
      doc.config.routing.providers.mode === "all"
        ? providers.providers
        : providers.providers.filter((p) =>
            Object.hasOwn(doc.config.routing.providers.selected ?? {}, p.slug),
          );
    return {
      appId,
      validation,
      status: doc.status,
      providers: selected.map((p) => ({
        id: p.id,
        slug: p.slug,
        status: p.status,
      })),
      ready:
        doc.status === "active" &&
        selected.some((p) => p.status === "active") &&
        !data.config_error,
      limitations: [
        "No inference was sent.",
        "Physical device attestation, issuer login, subscription entitlement and upstream credentials were not exercised.",
      ],
    };
  }
  if (action === "snippet") {
    const ios = doc.config.authentication.type === "apple_app_attest";
    const language = flags.language ?? (ios ? "swift" : "curl");
    if (!["swift", "curl"].includes(language))
      fail("invalid_input", "--language must be swift or curl.");
    // The two are not interchangeable: an iOS application's caller holds an
    // App Attest assertion rather than a key, and a server application holds a
    // key the Swift client has no way to send.
    if ((language === "swift") !== ios)
      fail(
        "unsupported_snippet",
        ios
          ? "iOS applications authenticate with App Attest, which curl cannot perform."
          : "Swift snippets are for iOS applications.",
        `Run agw app snippet ${appId} --language ${ios ? "swift" : "curl"}.`,
      );
    const notes: string[] = [];
    let example: RequestExample;
    if (flags.endpoint) {
      const endpoint = doc.config.endpoints?.[flags.endpoint];
      if (!endpoint)
        fail("endpoint_not_found", "Choose an existing named endpoint.");
      // A named endpoint holds the provider, the model and the parameters, so
      // the client sends only what its style documents.
      const responses = endpoint.api_style === "responses";
      example = {
        target: { endpoint: flags.endpoint },
        body: responses ? { input: "Say hello." } : null,
        anthropic: false,
        gaps: responses ? [] : ["body"],
      };
    } else {
      const routing = {
        providerMode: doc.config.routing.providers.mode,
        providers: doc.config.routing.providers.selected,
      };
      const { data: all } = await ctx.call("listProviders", []);
      // What this application may send to today, which is narrower than what
      // the account holds: a disabled provider serves nothing, and a selected
      // routing policy names the rest out.
      const reachable = all.providers.filter(
        (p) =>
          p.status === "active" &&
          (routing.providerMode === "all" ||
            Object.hasOwn(routing.providers ?? {}, p.slug)),
      );
      const requested = typeof flags.provider === "string" ? flags.provider : undefined;
      if (requested && !reachable.some((p) => p.slug === requested))
        fail(
          all.providers.some((p) => p.slug === requested)
            ? "provider_unavailable"
            : "provider_not_found",
          all.providers.some((p) => p.slug === requested)
            ? "That provider is disabled or outside this app's proxy policy."
            : "No provider has that slug.",
          "Run agw provider list for the slugs, and agw app show <id> for the policy.",
        );
      const { data: catalog } = await ctx.call("listModelPrices", []);
      const providers = requested
        ? reachable.filter((p) => p.slug === requested)
        : reachable;
      example = firstRequest(routing, providers, catalog.prices);
      if (!requested && reachable.length > 1)
        notes.push(`This app can reach ${reachable.length} providers. Add --provider <slug> for a different one.`);
    }
    notes.push(...exampleNotes(example));
    // The host applications call, which is not always the one this CLI manages
    // the gateway through: a deployment publishing a separate API domain names
    // it in its own deployment identity, and a snippet goes into a real app.
    const clientUrl = ctx.active?.deployment?.apiUrl ?? ctx.url;
    let snippet: string;
    if (ios) {
      const endUser = doc.config.authentication.type === "apple_app_attest"
        ? doc.config.authentication.end_user
        : undefined;
      const issuer = endUser?.source === "issuer";
      if (issuer)
        notes.push(
          "Replace yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh) with your configured issuer integration.",
        );
      snippet = swiftSnippet({
        baseUrl: clientUrl,
        appId,
        example,
        authMode: issuer
          ? ".appAttest(issuerTokenProvider: { forceRefresh in\n        // Return a fresh signed token from your configured identity SDK.\n        try await yourIdentitySDK.currentIDToken(forceRefresh: forceRefresh)\n    })"
          : ".appAttestInstall",
        notes: [
          "Swift package: https://github.com/maxceem/app-ai-gateway-swift (from: 1.0.0)",
          "Enable App Attest and test on a supported physical device.",
          ...notes,
        ],
      });
    } else {
      snippet = curlSnippet({ baseUrl: clientUrl, appId, example, notes });
    }
    if (flags.output) {
      const output = await reserveOutput(flags.output);
      try {
        await output.write(snippet);
        return { output: output.path };
      } finally {
        await output.cancel();
      }
    }
    return { language: ios ? "swift" : "shell", snippet, notes };
  }
  fail("unknown_command", "Unknown command.");
}
