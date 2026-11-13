import {
  AppWriteSchema,
  SNIPPET_LANGUAGES,
  type AppWrite,
  type SnippetLanguage,
} from "../../src/contracts/schemas.ts";
import type {
  AppResponse,
  AppDraftValidateResponse,
  AppSnippetResponse,
  AppValidateResponse,
} from "../../src/contracts/responses.ts";
import { CliError, describeIssues, fail } from "./common.ts";
import type { Context } from "./context.ts";
import type { Flags } from "./parser.ts";
import { flagList } from "./parser.ts";
import { jsonFile, required } from "./resources.ts";
import { reserveOutput, type StoredKeyMetadata } from "./state.ts";
import { sameJson, tolerant, valueAt, type Path, type Unknown } from "./tolerant.ts";
import { shellQuote } from "../../src/shared/first-request.ts";
import type { AppAttestEnvironment, AppAttestVerifyOn } from "../../src/shared/app-config.ts";
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
  | AppWriteResult
  | { dryRun: true; definition: AppWrite; validation: ValidationResult }
  | { appId: string; applicationKey: StoredKeyMetadata }
  | { output: string }
  | AppSnippetResponse;

/** A write body, and the settings in it this release does not know. */
interface AppDocument {
  doc: AppWrite;
  unknown: Unknown[];
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

/**
 * The app `app add` creates: the one `--file` holds, or one built from the
 * flags. Changing an existing app is the gateway's `app update`, whose
 * shortcuts it declares itself.
 */
export async function appDocument(flags: Flags): Promise<AppWrite> {
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
    return checkedApp(await jsonFile(flags.file), "any").doc;
  }
  const type = await required(flags, "type", "App type (ios or server)");
  if (!["ios", "server"].includes(type))
    fail("invalid_input", "App type must be ios or server.");
  const ios = type === "ios";
  if (!ios && IOS_FLAGS.some((k) => flags[k]))
    fail("invalid_input", "Server apps cannot use iOS flags.");
  if (ios && flags["key-output"])
    fail("invalid_input", "iOS apps cannot export a server application key.");
  const bundle = ios
    ? await required(flags, "bundle-id", "Apple bundle ID")
    : null;
  const doc = localApp({
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
  const auth = doc.config.authentication;
  // Passed through as typed, for `localApp` to refuse anything but
  // every_request or token_exchange.
  if (auth.type === "apple_app_attest" && flags["verify-on"])
    auth.app_attest.verify_on = flags["verify-on"].trim() as AppAttestVerifyOn;
  const selectedProviders = flagList(flags.provider);
  if (selectedProviders.length)
    doc.config.routing.providers = {
      mode: "selected",
      selected: Object.fromEntries(selectedProviders.map((slug) => [slug, emptyPolicy()])),
    };
  return localApp(doc);
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

/** The gateway's own verdict on a new application's document. */
async function remoteValidation(ctx: Context, doc: AppWrite): Promise<ValidationResult> {
  if (!ctx.managementKey)
    return {
      local: true,
      remote: false,
      skipped: [
        "Provider references, pricing, and saved configuration checks require login.",
      ],
    };
  const { data } = await ctx.call("validateAppDraft", { body: doc });
  return { local: true, remote: true, ...data };
}

/**
 * The app commands this CLI implements itself: `app add`, which writes a
 * server app's key to a private file and prints its first request, `app key
 * add`, which does the same for a further key, and `app snippet`, which can
 * write its example to a file. Every other app command is the gateway's.
 */
export async function appCommand(
  ctx: Context,
  command: string,
  args: string[],
  flags: Flags,
): Promise<AppResult> {
  const action = command.slice(4);
  if (action === "add") {
    const doc = await appDocument(flags);
    if (flags["key-output"] && doc.config.authentication.type !== "api_key")
      fail("invalid_input", "--key-output only applies to server apps.");
    if (flags["dry-run"])
      return {
        dryRun: true,
        definition: doc,
        validation: await remoteValidation(ctx, doc),
      };
    let app: AppResponse["app"];
    let key: StoredKeyMetadata | undefined;
    await ctx.bootstrap();
    if (doc.config.authentication.type === "api_key") {
      const created = await ctx.keyOperation("app.add", doc, flags["key-output"]);
      app = created.operation.result!.app!;
      key = created.key;
    } else {
      const created = await ctx.operation("app.add", doc);
      app = created.result!.app!;
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
  const appId = args[0] ?? "";
  if (action === "key add") {
    const { data: app } = await ctx.call("getApp", { params: { app: appId } });
    if (app.app.config.authentication.type !== "api_key")
      fail(
        "invalid_input",
        "Only server applications support application keys.",
      );
    const name = await required(flags, "name");
    if (!name.trim() || name.length > 100)
      fail("invalid_input", "Key name must be 1–100 characters.");
    const created = await ctx.keyOperation("app.key.add", { app: appId, name }, flags["key-output"]);
    return { appId, applicationKey: created.key };
  }
  // The gateway's own example, composed where the configuration and the
  // providers live, so every client writes the same one.
  if (action === "snippet") return appSnippet(ctx, appId, flags);
  fail("unknown_command", "Unknown command.");
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
