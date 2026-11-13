import {
  AppPatchSchema,
  AppWriteSchema,
  SNIPPET_LANGUAGES,
  type AppWrite,
  type SnippetLanguage,
} from "../../src/contracts/schemas.ts";
import type {
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  AppCheckResponse,
  AppDeleteResponse,
  AppListResponse,
  AppResponse,
  AppDraftValidateResponse,
  AppSnippetResponse,
  AppValidateResponse,
} from "../../src/contracts/responses.ts";
import { CliError, describeIssues, fail, validate, VERSION } from "./common.ts";
import type { Context } from "./context.ts";
import { canPrompt, confirm } from "./input.ts";
import type { Flags } from "./parser.ts";
import { flagList } from "./parser.ts";
import { jsonFile, required } from "./resources.ts";
import { reserveOutput, type StoredKeyMetadata } from "./state.ts";
import { formatPath, sameJson, tolerant, valueAt, type Path, type Unknown } from "./tolerant.ts";
import { shellQuote } from "../../src/shared/first-request.ts";
import {
  selectedProviderPolicies,
  type AppAttestEnvironment,
  type AppAttestVerifyOn,
} from "../../src/shared/app-config.ts";
import { emptyPolicy, newAppConfig } from "../../src/shared/app-defaults.ts";

/** What a local or remote configuration check was able to establish. */
export type ValidationResult =
  | { local: true; remote: false; skipped: string[] }
  | ({ local: true; remote: true } & (AppValidateResponse | AppDraftValidateResponse));

export interface AppWriteResult {
  snippet?: string;
  app: AppResponse["app"];
  applicationKey?: StoredKeyMetadata;
  guidance: string;
}

export type AppResult =
  | AppListResponse
  | AppResponse
  | AppDeleteResponse
  | ApiKeyListResponse
  | ApiKeyRevokeResponse
  | AppWriteResult
  | AppCheckResponse
  | { definition: AppWrite; validation: ValidationResult }
  | { dryRun: true; definition: AppWrite; validation: ValidationResult }
  | { appId: string; applicationKey: StoredKeyMetadata }
  | { output: string }
  | AppSnippetResponse;

/** A write body, and the settings in it this release does not know. */
export interface AppDocument {
  doc: AppWrite;
  unknown: Unknown[];
}

/**
 * The stored application as a write body, with every setting a newer gateway
 * wrote into it kept as it was read: an edit sends them back unchanged.
 */
export function documentOf(app: AppResponse["app"]): AppDocument {
  return checkedApp({ name: app.name, config: app.config, status: app.status }, "any");
}

/**
 * A write body as the gateway's own grammar defines it.
 *
 * Nothing is checked here beyond the schema: the App Attest identifier formats
 * and the rule that per-user limits need an end-user source live in the schema
 * the server parses with, so `agw` refuses exactly what the deployment would
 * and says it in the same words.
 */
export function localApp(value: unknown): AppWrite {
  return checkedApp(value).doc;
}

/**
 * Which settings this release does not know a document may carry: `any` for a
 * file, which the gateway judges in full when it is sent, or exactly the ones
 * an application was read with, each with the value it was read with.
 */
type Tolerance = "any" | readonly Unknown[];

const tolerated = (entry: { path: Path; value?: unknown }, tolerance: Tolerance, valued = true): boolean =>
  tolerance === "any" ||
  tolerance.some((known) =>
    sameJson(known.path, entry.path) && (!valued || sameJson(known.value, entry.value)));

/**
 * A write body checked against what this release knows of the grammar.
 *
 * A setting it does not know — a key it has no field for, a value its enum
 * does not list — is passed through untouched where `tolerance` allows it,
 * and the gateway, which does know it, has the final say when the body is
 * sent. Everything else is checked here as it always was. A setting that is
 * new here and not allowed is refused in the schema's own words.
 */
export function checkedApp(value: unknown, tolerance: Tolerance = []): AppDocument {
  const read = tolerant(AppWriteSchema, value);
  if (read && read.unknown.every((entry) => tolerated(entry, tolerance)))
    return { doc: read.data, unknown: read.unknown };
  const parsed = AppWriteSchema.safeParse(value);
  const issues = parsed.success ? [] : parsed.error.issues;
  // The settings that were allowed are not what is wrong, so they are not named.
  const reported = issues.filter((issue) => {
    if (issue.code === "unrecognized_keys")
      return !issue.keys.every((key) => tolerated({ path: [...issue.path, key] }, tolerance, false));
    if (issue.code === "invalid_value")
      return !tolerated({ path: issue.path, value: valueAt(value, issue.path) }, tolerance);
    // A variant no option names is reported at its discriminator, and kept as
    // the whole variant.
    if (issue.code === "invalid_union") {
      const variant = issue.path.slice(0, -1);
      return !tolerated({ path: variant, value: valueAt(value, variant) }, tolerance);
    }
    return true;
  });
  fail("invalid_input", describeIssues(reported.length ? reported : issues));
}

/** The type names this release can edit; a newer gateway may store others. */
const KNOWN_TYPES: readonly string[] = ["api_key", "apple_app_attest"];

export async function appDocument(
  flags: Flags,
  current?: AppWrite,
  unknown: readonly Unknown[] = [],
): Promise<AppWrite> {
  if (flags.file) {
    const permitted = new Set([
      "file",
      "json",
      "no-input",
      "dry-run",
      "key-output",
      "yes",
    ]);
    if (Object.keys(flags).some((k) => !permitted.has(k)))
      fail(
        "conflicting_flags",
        "--file replaces all application configuration flags.",
      );
    // A file may use settings newer than this release; the gateway checks
    // those when it is sent.
    const { doc } = checkedApp(await jsonFile(flags.file), "any");
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
      IOS_FLAGS.some((k) => flags[k])
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
      config: ios
        ? newAppConfig({
            type: "apple_app_attest",
            teamId: await required(flags, "team-id", "Apple team ID"),
            // Asked for above, because `ios` is exactly when there is one.
            bundleId: bundle ?? "",
            /*
             * Both environments, which is `agw`'s own default rather than the
             * schema's: someone reaching for the CLI to create an iOS app is
             * building it, and a development-signed build is what they have in
             * hand. Passed through unmapped, so `localApp` below is what
             * refuses a name that is neither.
             */
            environments: attestEnvironments(
              flags["attest-environments"] ?? "production,development",
            ),
          })
        : newAppConfig({ type: "api_key", endUser: { source: "none" } }),
    });
  }
  if (flags.name) doc.name = flags.name;
  if (flags.status) doc.status = flags.status === "disabled" ? "disabled" : "active";
  const auth = doc.config.authentication;
  // An application of a type this release has never heard of keeps its
  // authentication as it is, and an edit of it is refused rather than guessed.
  if (
    !KNOWN_TYPES.includes(auth.type) &&
    ([...IOS_FLAGS, "key-output"] as const).some((k) => flags[k])
  )
    fail(
      "cli_outdated",
      `This app uses authentication type ${auth.type}, which agw ${VERSION} does not know.`,
      "Update agw: npm install -g @maxceem/agw",
    );
  if (
    auth.type === "api_key" &&
    IOS_FLAGS.some((k) => flags[k])
  )
    fail("invalid_input", "Server apps cannot use iOS flags.");
  if (auth.type === "apple_app_attest") {
    if (flags["key-output"])
      fail("invalid_input", "iOS apps cannot export a server application key.");
    if (flags["team-id"]) auth.app_attest.team_id = flags["team-id"];
    if (flags["bundle-id"]) auth.app_attest.bundle_id = flags["bundle-id"];
    if (flags["attest-environments"])
      auth.app_attest.environments = attestEnvironments(flags["attest-environments"]);
    // Passed through as typed, for `localApp` to refuse anything but
    // every_request or token_exchange.
    if (flags["verify-on"])
      auth.app_attest.verify_on = flags["verify-on"].trim() as AppAttestVerifyOn;
  }
  const selectedProviders = flagList(flags.provider);
  // Within the mode it already has, the providers block keeps what else a
  // newer gateway wrote beside the selection; a change of mode replaces it.
  const providers = doc.config.routing.providers;
  if (selectedProviders.length) {
    const previous = selectedProviderPolicies(doc.config.routing);
    doc.config.routing.providers = {
      ...(providers.mode === "selected" ? providers : {}),
      mode: "selected",
      selected: Object.fromEntries(
        selectedProviders.map((slug) => [slug, previous[slug] ?? emptyPolicy()]),
      ),
    };
  }
  if (flags["all-providers"] && providers.mode !== "all") doc.config.routing.providers = { mode: "all" };
  return checkedApp(doc, unknown).doc;
}

/** The flags only an iOS (App Attest) application takes. */
const IOS_FLAGS = ["team-id", "bundle-id", "attest-environments", "verify-on"] as const satisfies readonly (keyof Flags)[];

/**
 * `--attest-environments` as the configuration's own list. Names are passed
 * through as typed rather than mapped, so `localApp` refuses one that is
 * neither `production` nor `development` instead of this flag quietly
 * widening a misspelling into production.
 */
function attestEnvironments(value: string): AppAttestEnvironment[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0) as AppAttestEnvironment[];
}

/**
 * The gateway's own verdict on a document: as an edit of the application `id`
 * names, or as a new application when there is none yet.
 */
async function remoteValidation(
  ctx: Context,
  doc: AppWrite,
  id?: string,
): Promise<ValidationResult> {
  if (!ctx.managementKey)
    return {
      local: true,
      remote: false,
      skipped: [
        "Provider references, pricing, and saved configuration checks require login.",
      ],
    };
  const { data } = id === undefined
    ? await ctx.call("validateAppDraft", { body: doc })
    : await ctx.call("validateApp", { params: { app: id }, body: doc });
  return { local: true, remote: true, ...data };
}

export async function appCommand(
  ctx: Context,
  command: string,
  args: string[],
  flags: Flags,
): Promise<AppResult> {
  const action = command.slice(4);
  if (action === "list") return (await ctx.call("listApps")).data;
  if (action === "patch") return appPatch(ctx, args[0] ?? "", flags);
  if (action === "validate") {
    const { doc, unknown } = checkedApp(await jsonFile(await required(flags, "file")), "any");
    const validation = await remoteValidation(ctx, doc);
    // Checked here only as far as this release knows the grammar, which a
    // local verdict has to say.
    if (!validation.remote && unknown.length)
      validation.skipped.push(
        `Settings agw ${VERSION} does not know were not checked: ${unknown.map((entry) => formatPath(entry.path)).join(", ")}.`,
      );
    return { definition: doc, validation };
  }
  if (action === "add" || action === "update") {
    let current: AppDocument | undefined;
    // The revision the edit is made against, read from the application itself.
    // It travels back in the write body: a deployment sits behind a CDN that
    // rewrites response headers, so the resource is the only channel that
    // carries it intact.
    let revision = 0;
    const appId = args[0] ?? "";
    if (action === "update") {
      const r = await ctx.call("getApp", { params: { app: appId } });
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
          (k) => !["json", "no-input", "dry-run", "yes"].includes(k),
        )
      )
        fail("invalid_input", "Provide at least one application change.");
    }
    const doc = await appDocument(flags, current?.doc, current?.unknown);
    if (flags.file && current) await replacing(ctx, appId, current.unknown, doc, flags);
    if (flags["key-output"] && doc.config.authentication.type !== "api_key")
      fail("invalid_input", "--key-output only applies to server apps.");
    if (flags["dry-run"])
      return {
        dryRun: true,
        definition: doc,
        validation: await remoteValidation(ctx, doc, appId || undefined),
      };
    {
      let app: AppResponse["app"];
      let key: StoredKeyMetadata | undefined;
      if (action === "add") {
        await ctx.bootstrap();
        if (doc.config.authentication.type === "api_key") {
          const created = await ctx.keyOperation("app.add", doc, flags["key-output"]);
          app = created.operation.result!.app!;
          key = created.key;
        } else {
          const created = await ctx.operation("app.add", doc);
          app = created.result!.app!;
        }
      } else {
        const updated = await ctx.call("updateApp", {
          params: { app: appId },
          body: { ...doc, revision },
        });
        ({ app } = updated.data);
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
        ...(key ? { applicationKey: key } : {}),
        guidance:
          doc.config.authentication.type === "apple_app_attest"
            ? `Add https://github.com/maxceem/app-ai-gateway-swift from 1.6.0, enable App Attest, and test on a supported physical device. Run agw app snippet ${app.id} --provider <slug> for integration code. Production releases should use production-only App Attest.`
            : `Store the generated key on your server; never embed it in a mobile application. Run agw app snippet ${app.id} for this request again.`,
      };
    }
  }
  if (action.startsWith("key ")) {
    const sub = action.slice(4);
    const appId = args[0] ?? "";
    const { data: app } = await ctx.call("getApp", { params: { app: appId } });
    if (app.app.config.authentication.type !== "api_key")
      fail(
        "invalid_input",
        "Only server applications support application keys.",
      );
    if (sub === "list") return (await ctx.call("listAppKeys", { params: { app: appId } })).data;
    if (sub === "revoke") {
      const keyId = args[1] ?? "";
      await confirm(
        `Revoke key ${keyId} for app ${appId}? Clients using it will lose access.`,
        flags,
      );
      return (await ctx.call("revokeAppKey", { params: { app: appId, key: keyId } })).data;
    }
    const name = await required(flags, "name");
    if (!name.trim() || name.length > 100)
      fail("invalid_input", "Key name must be 1–100 characters.");
    const created = await ctx.keyOperation("app.key.add", { app: appId, name }, flags["key-output"]);
    return { appId, applicationKey: created.key };
  }
  const appId = args[0] ?? "";
  // Both are the gateway's own answers, composed where the configuration and
  // the providers live, so every client reports the same verdict and writes
  // the same example.
  if (action === "check") return (await ctx.call("checkApp", { params: { app: appId } })).data;
  if (action === "snippet") return appSnippet(ctx, appId, flags);
  const { data } = await ctx.call("getApp", { params: { app: appId } });
  if (action === "show") return data;
  if (action === "remove") {
    await confirm(
      `Delete app ${data.app.name} (${appId})? Its keys, users and authentication state will be removed and clients will lose access.`,
      flags,
    );
    return (await ctx.call("deleteApp", { params: { app: appId }, query: { confirm: appId } })).data;
  }
  fail("unknown_command", "Unknown command.");
}

/**
 * `app patch`: the operations in `--file` — a list, or `{operations}` — sent
 * as one partial update against the revision the application has now. Only
 * the settings they name change, so nothing this release does not know is at
 * stake, and the gateway judges the result as it judges a whole update.
 */
async function appPatch(ctx: Context, appId: string, flags: Flags): Promise<AppResponse> {
  const file = await jsonFile(await required(flags, "file"));
  const operations = validate(
    AppPatchSchema.shape.operations,
    Array.isArray(file) ? file : (file as { operations?: unknown } | null)?.operations,
  );
  const { data: read } = await ctx.call("getApp", { params: { app: appId } });
  return (await ctx.call("patchApp", {
    params: { app: appId },
    body: { revision: read.app.revision, operations },
  })).data;
}

/**
 * `app update --file` replaces the whole configuration, so a setting the
 * application has and this release does not know survives only if the file
 * carries it as it is — which it does when it was saved from `app show
 * --json`, and does not when it was written by hand or saved by an older
 * release. Losing or changing one is said by path and needs `--yes`, because
 * nothing on this side can describe what it did.
 */
async function replacing(
  ctx: Context,
  appId: string,
  unknown: readonly Unknown[],
  doc: AppWrite,
  flags: Flags,
): Promise<void> {
  const removed = unknown
    .filter((entry) => !sameJson(valueAt(doc, entry.path), entry.value))
    .map((entry) => formatPath(entry.path));
  if (!removed.length) return;
  ctx.notice({
    code: "unknown_settings_replaced",
    message: `The file leaves out or changes settings ${appId} has that agw ${VERSION} does not understand; saving it replaces them.`,
    paths: removed,
  });
  if (flags["dry-run"] || flags.yes) return;
  if (!canPrompt(flags))
    fail(
      "confirmation_required",
      `Saving the file replaces settings agw ${VERSION} does not understand in ${appId}: ${removed.join(", ")}.`,
      "Copy them into the file from agw app show --json, or run the same command with --yes to replace them.",
    );
  await confirm("Save the file and replace them?", flags);
}

/**
 * `app snippet`: the example the gateway writes for the application, narrowed
 * by the flags, and written to `--output` where one is given. The refusals
 * keep the gateway's code and message and gain the command that answers them.
 */
async function appSnippet(ctx: Context, appId: string, flags: Flags): Promise<AppResult> {
  const language = flags.language;
  if (language !== undefined && !(SNIPPET_LANGUAGES as readonly string[]).includes(language))
    fail("invalid_input", "--language must be swift or curl.");
  const provider = typeof flags.provider === "string" ? flags.provider : undefined;
  let data: AppSnippetResponse;
  try {
    ({ data } = await ctx.call("getAppSnippet", {
      params: { app: appId },
      query: {
        ...(language === undefined ? {} : { language: language as SnippetLanguage }),
        ...(provider === undefined ? {} : { provider }),
        ...(flags.endpoint === undefined ? {} : { endpoint: flags.endpoint }),
      },
    }));
  } catch (error) {
    const remedy = error instanceof CliError ? snippetRemedy(error.code, appId, language) : undefined;
    if (remedy === undefined || !(error instanceof CliError)) throw error;
    throw new CliError(error.code, error.message, remedy, error.exitCode, error.details);
  }
  if (flags.output) {
    const output = await reserveOutput(flags.output);
    try {
      await output.write(data.snippet);
      return { output: output.path };
    } finally {
      await output.cancel();
    }
  }
  return data;
}

/** The command that answers each refusal of `app snippet`, where there is one. */
function snippetRemedy(code: string, appId: string, language: string | undefined): string | undefined {
  switch (code) {
    // Only a language that was asked for is refused, so the other one is right.
    case "unsupported_snippet":
      return `Run agw app snippet ${appId} --language ${language === "swift" ? "curl" : "swift"}.`;
    case "provider_not_found":
    case "provider_unavailable":
      return "Run agw provider list for the slugs, and agw app show <id> for the policy.";
    case "endpoint_not_found":
      return `Run agw app show ${appId} for its custom endpoints.`;
    default:
      return undefined;
  }
}
