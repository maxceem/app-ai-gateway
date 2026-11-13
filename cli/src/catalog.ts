/**
 * The commands this CLI does not implement itself, as the connected gateway
 * describes them.
 *
 * A gateway serves its MCP tools at `GET /v1/cli/tools`, each with the command
 * it is offered as. That list is kept per gateway in the cache directory and
 * is what every such command is parsed, explained and run against, so a tool
 * added to a gateway is a command of this CLI as soon as the gateway is
 * deployed. It is fetched again:
 *
 * - when it is more than a day old;
 * - when a tool call answers with another revision than the one kept, which is
 *   how a deploy reaches a CLI that ran a minute before it;
 * - once per run, when a command is not in it.
 *
 * A gateway that cannot be reached leaves the list kept as it was, however old.
 *
 * What the list may do is deliberately narrow: it names commands, arguments
 * and how a result is laid out, all of them data. It is only ever fetched from
 * the selected gateway, it never names a file or a URL the CLI acts on, and
 * every piece of it is cleaned of control characters before a terminal sees it.
 */

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CliToolCatalogResponseSchema, type CliTool } from "../../src/contracts/cli.ts";
import { CliError, fail, randomToken } from "./common.ts";
import type { Context } from "./context.ts";
import { cacheDirectory, protectedDirectory } from "./state.ts";

export type { CliTool };

/** How long a kept list is used without asking the gateway again. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** How long fetching the list may take. */
const FETCH_MS = 10_000;

export const CachedCatalogSchema = CliToolCatalogResponseSchema.extend({
  /** The gateway it came from. */
  url: z.string(),
  /** When it was fetched, in milliseconds since the epoch. */
  fetchedAt: z.number(),
});

export type CachedCatalog = z.infer<typeof CachedCatalogSchema>;

/** Where lists are kept between runs; swapped for an in-memory one in tests. */
export interface CatalogCache {
  read(url: string): Promise<CachedCatalog | undefined>;
  write(catalog: CachedCatalog): Promise<void>;
}

/** One file per gateway under the cache directory, readable by this user only. */
export class FileCatalogCache implements CatalogCache {
  private readonly directory: string;

  constructor(directory = join(cacheDirectory(), "tools")) {
    this.directory = directory;
  }

  private path(url: string): string {
    return join(this.directory, `${createHash("sha256").update(url).digest("hex").slice(0, 24)}.json`);
  }

  async read(url: string): Promise<CachedCatalog | undefined> {
    try {
      const parsed = CachedCatalogSchema.safeParse(JSON.parse(await readFile(this.path(url), "utf8")));
      // A file another gateway's list was written to is not this one's.
      return parsed.success && parsed.data.url === url ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(catalog: CachedCatalog): Promise<void> {
    await protectedDirectory(this.directory);
    const target = this.path(catalog.url);
    const temp = `${target}.${randomToken().slice(0, 12)}.tmp`;
    await writeFile(temp, JSON.stringify(catalog), { mode: 0o600 });
    await rename(temp, target);
  }
}

/** Command words a tool is offered as, and whether `words` starts with them. */
export function commandWords(tool: CliTool): string[] {
  return tool.cli.command.trim().split(/\s+/u);
}

/**
 * The tool whose command `words` start with, the longest such command first,
 * leaving out the commands this CLI implements itself.
 */
export function findTool(
  tools: readonly CliTool[],
  words: readonly string[],
  builtIn: (command: string) => boolean,
): CliTool | undefined {
  let best: CliTool | undefined;
  for (const tool of tools) {
    const command = commandWords(tool);
    if (builtIn(command.join(" "))) continue;
    if (command.length > words.length) continue;
    if (!command.every((word, index) => words[index] === word)) continue;
    if (!best || command.length > commandWords(best).length) best = tool;
  }
  return best;
}

export class ToolCatalog {
  private current: CachedCatalog | undefined;
  /** Whether this run has already asked the gateway, which it does at most once. */
  private fetched = false;

  private readonly ctx: Pick<Context, "url" | "publicCall">;
  private readonly cache: CatalogCache;
  private readonly now: () => number;

  constructor(ctx: Pick<Context, "url" | "publicCall">, cache: CatalogCache, now: () => number = Date.now) {
    this.ctx = ctx;
    this.cache = cache;
    this.now = now;
  }

  /**
   * The list for the selected gateway: the one kept while it is fresh,
   * otherwise the gateway's, otherwise — when the gateway cannot be reached —
   * the one kept, however old.
   */
  async load(): Promise<CachedCatalog> {
    if (this.current) return this.current;
    const kept = await this.cache.read(this.ctx.url);
    if (kept && this.now() - kept.fetchedAt < CATALOG_TTL_MS) return (this.current = kept);
    try {
      return await this.refresh();
    } catch (error) {
      if (kept && error instanceof CliError && error.code === "connection_failed") return (this.current = kept);
      throw error;
    }
  }

  /** The gateway's list, fetched now and kept; at most once per run. */
  async refresh(): Promise<CachedCatalog> {
    if (this.fetched && this.current) return this.current;
    this.fetched = true;
    let data;
    try {
      ({ data } = await this.ctx.publicCall("listCliTools", { timeoutMs: FETCH_MS }));
    } catch (error) {
      // A gateway from before this list existed answers it as a route it does not have.
      if (error instanceof CliError && error.details?.status === 404)
        fail(
          "gateway_outdated",
          "This gateway is older than this agw and does not describe its commands.",
          "Update the gateway with agw deployment update, or use the agw release it was deployed with.",
          3,
        );
      throw error;
    }
    const catalog: CachedCatalog = { ...data, url: this.ctx.url, fetchedAt: this.now() };
    this.current = catalog;
    // Keeping it is a convenience: a list that cannot be written is fetched again next run.
    await this.cache.write(catalog).catch(() => {});
    return catalog;
  }

  /** Whether this run has already fetched the list, so a miss cannot be a stale list. */
  get fresh(): boolean {
    return this.fetched;
  }

  /**
   * What a tool call said the gateway's revision is: another than the one kept
   * means the gateway changed, and the list is fetched again for the next run.
   * Never a reason for the command that just succeeded to fail.
   */
  async observe(revision: string | null | undefined): Promise<void> {
    if (!revision || !this.current || this.current.revision === revision || this.fetched) return;
    await this.refresh().catch(() => {});
  }
}
