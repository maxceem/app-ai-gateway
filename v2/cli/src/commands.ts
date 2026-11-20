/**
 * The built-in commands that change things: the ones that need this machine,
 * because a provider key comes from a hidden prompt, stdin or a browser, or a
 * new app key goes to a private file. Every other change is a gateway command,
 * built from its tool list.
 */
import { readFile, unlink } from "node:fs/promises";
import { APP_STATUSES } from "../../src/contracts/admin.ts";
import type { OperationResponse } from "../../src/contracts/catalog.ts";
import { CliError, fail } from "./common.ts";
import type { Context } from "./context.ts";
import { secret } from "./input.ts";
import type { Flags } from "./parser.ts";
import type { KeyOutput } from "./state.ts";

type Provider = OperationResponse<"getProvider">["provider"];
type CreatedKey = NonNullable<OperationResponse<"createApp">["api_key"]>;
type OperationStatus = OperationResponse<"getOperation">;

/** What a new app key looks like once it is in its file: everything but the key. */
export interface StoredKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  /** The private file the key was written to. */
  storagePath: string;
}

export interface ProviderResult {
  provider: Provider;
}

export interface AppAddResult {
  app: OperationResponse<"createApp">["app"];
  /** The first key of a server app, in its file. Null for an iOS app. */
  key: StoredKey | null;
}

export interface AppValidateResult {
  valid: true;
  dryRun: true;
}

export interface AppKeyAddResult {
  app_id: string;
  key: StoredKey;
}

export interface AppUpdateResult {
  app: OperationResponse<"patchApp">["app"];
}

/** A value given inline, or read from the file `@path` names. */
async function jsonFlag(name: string, value: string): Promise<unknown> {
  let text = value;
  if (value.startsWith("@")) {
    try {
      text = await readFile(value.slice(1), "utf8");
    } catch {
      fail("invalid_input", `--${name}: cannot read ${value.slice(1)}.`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_input", `--${name} must be JSON, inline or as @file.`);
  }
}

/** A provider connection by its id or its slug. */
async function findProvider(ctx: Context, reference: string): Promise<Provider> {
  const { data } = await ctx.call("listProviders");
  const provider = data.providers.find((entry) => entry.id === reference) ?? data.providers.find((entry) => entry.slug === reference);
  if (!provider)
    fail("provider_not_found", "None of your provider connections has that id or slug.", "Run agw provider list to see them.", 4);
  return provider;
}

/** Refuses a browser link that is not on the selected gateway's own origin. */
function assertOwnPage(ctx: Context, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail("invalid_response", "The gateway answered with an unusable approval link.", undefined, 3);
  }
  if (parsed.origin !== ctx.url || parsed.username || parsed.password)
    fail("invalid_response", "The approval link is not on this gateway's own console, so agw will not open it.", undefined, 3);
}

/**
 * A browser step: the person types the provider key in the console, never in
 * this terminal. The page is opened here, and the command waits for it unless
 * it was asked not to, in which case it answers the pending operation.
 */
async function browserStep(
  ctx: Context,
  opened: OperationResponse<"openProviderHandoff">,
): Promise<ProviderResult | OperationStatus> {
  assertOwnPage(ctx, opened.url);
  if (opened.notice) ctx.say(`Note: ${opened.notice.replace(/[\p{Cc}\p{Cf}]/gu, " ")}`);
  // The link carries the page's proof, so it is never printed: a browser
  // opened here gets it, and otherwise it goes to a private file.
  const shown = !ctx.flags["no-open"] && (await ctx.io.openBrowser(opened.url));
  let file: string | undefined;
  if (shown) ctx.say(`Enter the key in the browser window that opened.\nOperation: ${opened.id}`);
  else {
    file = await ctx.store.handoffFile(opened.id, opened.url);
    ctx.say(`Open the link saved in ${file} (readable only by you) to enter the key.\nOperation: ${opened.id}`);
  }
  if (ctx.flags.json || ctx.flags["no-input"]) {
    const { data } = await ctx.call("getOperation", { params: { id: opened.id } });
    return data;
  }
  try {
    const done = await waitFor(ctx, opened.id, 900);
    return done.result?.provider ? { provider: done.result.provider } : done;
  } finally {
    // Once this command stops waiting, the link has done its work here.
    if (file) await unlink(file).catch(() => {});
  }
}

/** Polls an operation until it completes, or fails once it lapses or is declined. */
export async function waitFor(ctx: Context, id: string, seconds: number): Promise<OperationStatus> {
  const end = ctx.io.clock.now() + seconds * 1000;
  for (;;) {
    const { data } = await ctx.call("getOperation", { params: { id } });
    if (data.state === "completed") return data;
    if (data.state === "expired") {
      if (data.denied) fail("operation_denied", "The browser step was declined.", "Run the command again to start over.", 4, { id });
      fail("operation_expired", "The browser step lapsed before it was completed.", "Run the command again to start over.", 4, { id });
    }
    if (ctx.io.clock.now() >= end)
      fail("operation_pending", "The browser step is still waiting.", `Run agw operation wait ${id} to keep waiting.`, 4, {
        id,
        state: data.state,
        expiresAt: data.expiresAt,
      });
    await ctx.io.clock.sleep(2000);
  }
}

/** `agw provider add`. */
export async function providerAdd(ctx: Context, flags: Flags): Promise<ProviderResult | OperationStatus> {
  const type = flags.type?.trim();
  const name = flags.name?.trim() || type;
  if (!type) fail("invalid_input", "--type is required, such as --type openai.", "Run agw provider list or agw model list to see the types.");
  const pricing = flags.pricing === undefined ? undefined : await jsonFlag("pricing", flags.pricing);
  const common = {
    type,
    name: name!,
    ...(flags.slug === undefined ? {} : { slug: flags.slug }),
    ...(flags["base-url"] === undefined ? {} : { baseUrl: flags["base-url"] }),
    ...(pricing === undefined ? {} : { pricing: pricing as never }),
  };
  if (flags.browser) {
    const { data } = await ctx.call("openProviderHandoff", { body: common });
    return browserStep(ctx, data);
  }
  const key = await secret(flags, "Provider API key");
  if (!key) fail("input_required", "A provider key is required.", "Pipe it with --key-stdin, type it with --key-prompt, or use --browser.");
  const { data } = await ctx.call("createProvider", { body: { ...common, secret: key } });
  return { provider: data.provider };
}

/** `agw provider rotate-key <id or slug>`. */
export async function providerRotateKey(ctx: Context, reference: string, flags: Flags): Promise<ProviderResult | OperationStatus> {
  const provider = await findProvider(ctx, reference);
  if (flags.browser) {
    const { data } = await ctx.call("openProviderKeyHandoff", { params: { id: provider.id }, body: { revision: provider.revision } });
    return browserStep(ctx, data);
  }
  const key = await secret(flags, "New provider API key");
  if (!key) fail("input_required", "The new key is required.", "Pipe it with --key-stdin, type it with --key-prompt, or use --browser.");
  const { data } = await ctx.call("updateProvider", { params: { id: provider.id }, body: { revision: provider.revision, secret: key } });
  return { provider: data.provider };
}

/** The app document `app add` sends: the one `--file` holds, or one built from flags. */
async function appDocument(flags: Flags): Promise<{ name: string; config: unknown; status?: (typeof APP_STATUSES)[number] }> {
  if (flags.file !== undefined) {
    const document = await jsonFlag("file", flags.file.startsWith("@") ? flags.file : `@${flags.file}`);
    if (typeof document !== "object" || document === null || Array.isArray(document))
      fail("invalid_input", "--file must hold an app document: {name, config, status?}.");
    return document as { name: string; config: unknown };
  }
  const name = flags.name?.trim();
  if (!name) fail("invalid_input", "--name is required, or --file with a whole app document.");
  const type = flags.type ?? "ios";
  if (type === "ios") {
    if (!flags["team-id"] || !flags["bundle-id"])
      fail("invalid_input", "An iOS app needs --team-id and --bundle-id.", "Find them in your Apple developer account and in Xcode.");
    return {
      name,
      config: {
        authentication: {
          type: "apple_app_attest",
          end_user: { source: "app_install" },
          app_attest: { team_id: flags["team-id"].trim(), bundle_id: flags["bundle-id"].trim() },
        },
      },
    };
  }
  if (type !== "server") fail("invalid_input", "--type must be ios or server.");
  const header = flags["user-header"]?.trim();
  return {
    name,
    config: { authentication: { type: "api_key", end_user: header ? { source: "header", header } : { source: "none" } } },
  };
}

/** Writes a new key to its reserved file; a failure says which key was made, so it can be revoked. */
async function storeKey(output: KeyOutput, minted: CreatedKey, appId: string): Promise<StoredKey> {
  try {
    await output.write(minted.key + "\n");
  } catch {
    fail(
      "key_output_failed",
      "The key was created, but its file could not be written, and the gateway never shows it again.",
      `Revoke it with agw app key revoke ${appId} ${minted.id}, then create another with agw app key add.`,
      4,
      { appId, keyId: minted.id, storagePath: output.path },
    );
  }
  return { id: minted.id, name: minted.name, key_prefix: minted.key_prefix, created_at: minted.created_at, storagePath: output.path };
}

/** `agw app add`: an iOS or server app; a server app's first key goes to a private file. */
export async function appAdd(ctx: Context, flags: Flags): Promise<AppAddResult | AppValidateResult> {
  const document = await appDocument(flags);
  if (flags["dry-run"]) {
    await ctx.call("validateAppDraft", { body: document as never });
    return { valid: true, dryRun: true };
  }
  const isServer =
    (document.config as { authentication?: { type?: unknown } } | null)?.authentication?.type === "api_key";
  // Reserved before anything is created, so a path that is taken fails first.
  const output = isServer ? await ctx.store.keyOutput(flags["key-output"]) : null;
  try {
    const { data } = await ctx.call("createApp", { body: document as never });
    const key = data.api_key && output ? await storeKey(output, data.api_key, data.app.id) : null;
    return { app: data.app, key };
  } finally {
    await output?.cancel();
  }
}

/** `agw app key add <app>`. */
export async function appKeyAdd(ctx: Context, app: string, flags: Flags): Promise<AppKeyAddResult> {
  const name = flags.name?.trim();
  if (!name) fail("invalid_input", "--name is required, to tell the key apart in agw app key list.");
  const output = await ctx.store.keyOutput(flags["key-output"]);
  try {
    const { data } = await ctx.call("createAppKey", { params: { app }, body: { name } });
    return { app_id: app, key: await storeKey(output, data, app) };
  } finally {
    await output.cancel();
  }
}

const STATUSES: ReadonlySet<string> = new Set(APP_STATUSES);

/**
 * `agw app update <app>`: `--name` and `--status` as shortcuts, or
 * `--operations` (a JSON Patch) with `--revision`, applied by the gateway's
 * `patchApp`. A shortcut reads the app's current revision first, and is sent
 * once more when someone else changed the app in between, since a new name or
 * status cannot clash with their change.
 */
export async function appUpdate(ctx: Context, app: string, flags: Flags): Promise<AppUpdateResult> {
  const shortcuts: { op: "replace"; path: string; value: string }[] = [];
  if (flags.name !== undefined) {
    if (!flags.name.trim()) fail("invalid_input", "--name cannot be empty.");
    shortcuts.push({ op: "replace", path: "/name", value: flags.name.trim() });
  }
  if (flags.status !== undefined) {
    if (!STATUSES.has(flags.status)) fail("invalid_input", `--status must be one of ${APP_STATUSES.join(", ")}.`);
    shortcuts.push({ op: "replace", path: "/status", value: flags.status });
  }
  if (flags.operations !== undefined) {
    if (shortcuts.length) fail("conflicting_flags", "--operations cannot be combined with --name or --status.");
    if (flags.revision === undefined)
      fail("invalid_input", "--operations needs --revision, the revision agw app show printed.", "Run agw app show to read it.");
    const revision = Number(flags.revision);
    if (!Number.isInteger(revision) || revision < 1) fail("invalid_input", "--revision must be a whole number.");
    const operations = await jsonFlag("operations", flags.operations);
    const { data } = await ctx.call("patchApp", { params: { app }, body: { revision, operations } as never });
    return { app: data.app };
  }
  if (!shortcuts.length)
    fail("invalid_input", "Name what to change: --name, --status, or --operations with --revision.", "Run agw app update --help.");
  for (let attempt = 0; ; attempt++) {
    const { data: current } = await ctx.call("getApp", { params: { app } });
    try {
      const { data } = await ctx.call("patchApp", {
        params: { app },
        body: { revision: current.app.revision, operations: shortcuts } as never,
      });
      return { app: data.app };
    } catch (error) {
      if (attempt === 0 && error instanceof CliError && error.code === "app_revision_conflict") continue;
      throw error;
    }
  }
}
