/**
 * Matches a request to a declared operation or a listed passthrough path.
 * Closed by default: anything else is refused.
 *
 * The order is fixed (plan sections 4.1 and 4.5):
 *
 * 1. Normalize the path. A path that could mean something else upstream is
 *    refused.
 * 2. The provider's refused paths, ignoring case. These win even over a path
 *    the customer listed.
 * 3. Passthrough paths the customer listed for this connection. They come
 *    before declared operations, so a release that declares an operation
 *    for a listed path never switches it on its own: the customer makes
 *    that switch (plan section 4.5).
 * 4. Declared operations, in the order the provider lists them.
 * 5. Everything else is refused.
 *
 * Which operations an app allows is decided after this, by the app's settings.
 */
import type { HttpMethod, OperationDescription, ProviderDescription } from "./operation.ts";
import {
  fillTemplate,
  joinSegments,
  matchTemplate,
  normalizePath,
  parseTemplate,
  TemplateError,
  type ClosedLists,
  type Parts,
  type PathRefusal,
  type Template,
  type TemplateSegment,
} from "./path.ts";

/** A path a customer listed for passthrough (plan section 4.5). */
export interface PassthroughPath {
  readonly method: HttpMethod;
  /** A template with `{name}` parts only. A part never spans a `/`. */
  readonly path: string;
  /** A flat price per request, in nano-dollars. Without it, the charge is `not_priced`. */
  readonly priceNano?: number;
}

/** Where the request goes: a key of the provider's `hosts`, and the encoded path. */
export interface UpstreamTarget {
  readonly host: string;
  readonly path: string;
}

export type MatchResult =
  | {
      readonly kind: "operation";
      readonly operation: OperationDescription;
      readonly parts: Parts;
      readonly upstream: UpstreamTarget;
    }
  | {
      readonly kind: "passthrough";
      readonly listed: PassthroughPath;
      readonly parts: Parts;
      readonly upstream: UpstreamTarget;
    }
  | { readonly kind: "refused"; readonly reason: "bad_path"; readonly detail: PathRefusal }
  | { readonly kind: "refused"; readonly reason: "refused_path"; readonly pattern: string }
  | { readonly kind: "refused"; readonly reason: "not_declared" };

interface CompiledOperation {
  readonly operation: OperationDescription;
  readonly template: Template;
  readonly upstream: Template | null;
  readonly host: string;
  /**
   * Each `{name...}` part's list: a fixed one, or `any` for the priced
   * models, which are judged after routing, where the request is admitted
   * (`resolveCall`, `../pricing/billability.ts`).
   */
  readonly closedLists: ClosedLists;
}

export interface CompiledPassthrough {
  readonly listed: PassthroughPath;
  readonly template: Template;
}

export class ProviderDescriptionError extends Error {
  constructor(provider: string, problem: string) {
    super(`Provider "${provider}": ${problem}`);
    this.name = "ProviderDescriptionError";
  }
}

/**
 * Checks a customer's passthrough list. Called when the list is saved, so a
 * bad template is refused then, not on a live request.
 */
export function compilePassthrough(paths: readonly PassthroughPath[]): readonly CompiledPassthrough[] {
  return paths.map((listed) => {
    if (listed.priceNano !== undefined && !(Number.isSafeInteger(listed.priceNano) && listed.priceNano >= 0)) {
      throw new TemplateError(listed.path, "price must be a whole number of nano-dollars, 0 or more");
    }
    // Only characters a path segment may hold as they are: a literal is
    // compared with the decoded request, so an encoded one could never match.
    if (!LISTED_PATH.test(listed.path)) {
      throw new TemplateError(listed.path, "may hold only letters, digits, {name} parts and - . _ ~ : @ ! $ & ' ( ) + , ; = /");
    }
    return { listed, template: parseTemplate(listed.path) };
  });
}

/** The characters a listed path may hold: RFC 3986 `pchar` without `%` and `*`, plus `/`, `{` and `}`. */
const LISTED_PATH = /^[A-Za-z0-9\-._~:@!$&'()+,;=/{}]+$/u;

/**
 * A value no template literal can hold (a `{` always starts a part), standing
 * for any value of a listed path's part. If a pattern matches a path with it,
 * the pattern matches the path whatever the part holds.
 */
const ANY_VALUE = "{}";

/** One segment of a listed path, or of an operation's path outside its `{name...}` part. */
type SegmentPattern = Extract<TemplateSegment, { kind: "literal" } | { kind: "part" }>;

/** Whether some one segment matches both patterns, as `matchTemplate` compares them: exactly. */
function segmentsMeet(a: SegmentPattern, b: SegmentPattern): boolean {
  if (a.kind === "literal" && b.kind === "literal") return a.value === b.value;
  if (a.kind === "literal") return literalFits(a.value, b as Extract<TemplateSegment, { kind: "part" }>);
  if (b.kind === "literal") return literalFits(b.value, a);
  // Two parts meet when one prefix starts the other and one suffix ends the
  // other: a value long enough then fills both, each part non-empty.
  const prefixes = a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  const suffixes = a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix);
  return prefixes && suffixes;
}

function literalFits(value: string, part: Extract<TemplateSegment, { kind: "part" }>): boolean {
  return value.length > part.prefix.length + part.suffix.length && value.startsWith(part.prefix) && value.endsWith(part.suffix);
}

/**
 * How a connection's requests reach its provider, as far as their paths go
 * (`upstreamRoute`). Refused paths and declared operations are written as the
 * provider reads its paths, so they are judged on the upstream target a
 * request reaches (`upstreamTargets`), not on the gateway path alone.
 */
export interface UpstreamRoute {
  /** The path of the connection's base URL, in segments, put before every path to the main host. Null without one. */
  readonly basePath: readonly string[] | null;
  /**
   * Through Cloudflare AI Gateway: the path Cloudflare's endpoint for the
   * provider stands for (`stripPathPrefix`, OpenAI's `v1`), in segments. A
   * path that starts with it is sent without it, and the provider reads it
   * back on; any other path is read with it added. Null when direct.
   */
  readonly cloudflarePrefix: readonly string[] | null;
  /**
   * A base URL on one of the provider's own hosts (`https://openrouter.ai/`):
   * that host's built-in path prefix (`api`), in segments, under which the
   * provider reads its paths. Null otherwise.
   */
  readonly hostPrefix?: readonly string[] | null;
}

/** The provider's own hosts, with no base URL or Cloudflare. */
export const DIRECT_ROUTE: UpstreamRoute = { basePath: null, cloudflarePrefix: null };

const pathSegments = (pathname: string): string[] =>
  pathname.split("/").filter((piece) => piece !== "").map((piece) => {
    try {
      return decodeURIComponent(piece);
    } catch {
      return piece;
    }
  });

/**
 * A connection's route, as `upstreamRequest` (`./route.ts`) sends it:
 * through Cloudflare AI Gateway when it has that setting, else to its base
 * URL when it has one, else to the provider's hosts.
 */
export function upstreamRoute(
  description: ProviderDescription,
  connection: { readonly baseUrl: string | null; readonly cloudflareGateway: object | null },
): UpstreamRoute {
  if (connection.cloudflareGateway !== null) {
    const prefix = description.cloudflareGateway?.stripPathPrefix ?? "";
    return { basePath: null, cloudflarePrefix: prefix.split("/").filter((piece) => piece !== "") };
  }
  if (connection.baseUrl !== null) {
    let url: URL | null = null;
    try {
      url = new URL(connection.baseUrl);
    } catch {
      // A stored base URL passed the origin guard; one that does not read sends nothing anyway.
    }
    const basePath = pathSegments(url?.pathname ?? "/");
    // On one of the provider's own hosts, its paths are read under that host's built-in prefix.
    const own = Object.values(description.hosts)
      .map((host) => ({ name: host.split("/")[0]!.toLowerCase(), prefix: pathSegments(host.slice(host.split("/")[0]!.length)) }))
      .find((host) => host.name === url?.host.toLowerCase() && host.prefix.length > 0);
    return { basePath, cloudflarePrefix: null, ...(own !== undefined ? { hostPrefix: own.prefix } : {}) };
  }
  return DIRECT_ROUTE;
}

/** Where a path sent on a host reaches: the host, and each path the provider may read it as. */
export interface UpstreamTargets {
  /** A key of the provider's `hosts`. The main host stands for the base URL or Cloudflare too. */
  readonly host: string;
  readonly paths: readonly (readonly TemplateSegment[])[];
}

const literal = (value: string): TemplateSegment => ({ kind: "literal", value });

/**
 * The upstream targets of `path` (decoded request segments as literals, or a
 * template) sent to `hostKey` on `route`, written as the provider reads its
 * paths. The one place this is worked out; saving and serving both use it.
 *
 * - Direct: the path itself, under the host's own path prefix.
 * - A base URL (main host only): its path, then the request's. Where the base
 *   URL mounts the provider is not known, so each way of reading it is a
 *   target: the whole base path, then without its first segment, and so on.
 * - Cloudflare AI Gateway (main host only): Cloudflare's provider endpoint
 *   adds back its prefix (`cloudflarePrefix`). A path that may or may not
 *   start with it (a `{name}` part there) has both targets.
 *
 * Null for a host Cloudflare does not serve: nothing is sent there.
 */
export function upstreamTargets(route: UpstreamRoute, hostKey: string, path: readonly TemplateSegment[]): UpstreamTargets | null {
  if (hostKey !== "main") return route.cloudflarePrefix !== null ? null : { host: hostKey, paths: [path] };
  const prefix = route.cloudflarePrefix;
  if (prefix !== null) {
    if (prefix.length === 0) return { host: "main", paths: [path] };
    const added = [...prefix.map(literal), ...path];
    const head = path.slice(0, prefix.length);
    const starts = head.length === prefix.length && head.every((segment, index) => segment.kind === "literal" && segment.value === prefix[index]);
    if (starts) return { host: "main", paths: [path] };
    const may =
      head.length === prefix.length &&
      head.every((segment, index) => (segment.kind === "literal" || segment.kind === "part") && segmentsMeet(segment, { kind: "literal", value: prefix[index]! }));
    return { host: "main", paths: may ? [path, added] : [added] };
  }
  const base = route.basePath;
  if (base === null) return { host: "main", paths: [path] };
  const paths: (readonly TemplateSegment[])[] = base.map((_, from) => [...base.slice(from).map(literal), ...path]);
  paths.push(path);
  // A base URL on the provider's own host: the provider reads the whole path
  // under its built-in prefix, so that prefix is taken off where it may lead.
  const own = route.hostPrefix ?? [];
  if (own.length > 0) {
    const whole = [...base.map(literal), ...path];
    const head = whole.slice(0, own.length);
    const may =
      head.length === own.length &&
      head.every((segment, index) => (segment.kind === "literal" || segment.kind === "part") && segmentsMeet(segment, { kind: "literal", value: own[index]! }));
    if (may) paths.push(whole.slice(own.length));
  }
  return { host: "main", paths };
}

export interface MatchContext {
  /** The connection's listed passthrough paths, from `compilePassthrough`. */
  readonly passthrough?: readonly CompiledPassthrough[];
  /** The connection's route (`upstreamRoute`). Direct when left out. */
  readonly route?: UpstreamRoute;
}

export class ProviderMatcher {
  readonly provider: ProviderDescription;
  /** Each refused path, with the methods it refuses, or null for every method. */
  private readonly refused: readonly { readonly template: Template; readonly methods: ReadonlySet<string> | null }[];
  private readonly operations: readonly CompiledOperation[];

  /**
   * Compiles every template once. Throws on a broken description, so a test
   * that builds every provider's matcher catches it before deploy.
   *
   * `extraRefused` adds another provider's refused paths, for a custom
   * provider whose host belongs to a built-in one.
   */
  constructor(provider: ProviderDescription, extraRefused: ProviderDescription["refused"] = []) {
    this.provider = provider;
    this.refused = [...provider.refused, ...extraRefused].map((entry) =>
      typeof entry === "string"
        ? { template: parseTemplate(entry, { rest: true }), methods: null }
        : { template: parseTemplate(entry.path, { rest: true }), methods: new Set(entry.methods) },
    );
    const names = new Set<string>();
    this.operations = provider.operations.map((operation) => {
      if (names.has(operation.name)) {
        throw new ProviderDescriptionError(provider.type, `operation "${operation.name}" is declared twice`);
      }
      names.add(operation.name);
      const template = parseTemplate(operation.match.path, { multi: true });
      const partNames = new Set(
        template.segments.flatMap((segment) =>
          segment.kind === "part" || segment.kind === "multi" ? [segment.name] : [],
        ),
      );
      const upstream =
        operation.upstream?.path === undefined ? null : parseTemplate(operation.upstream.path, { multi: true });
      for (const segment of upstream?.segments ?? []) {
        if ((segment.kind === "part" || segment.kind === "multi") && !partNames.has(segment.name)) {
          throw new ProviderDescriptionError(
            provider.type,
            `operation "${operation.name}" sends {${segment.name}} upstream, but its path has no such part`,
          );
        }
      }
      const hostKey = operation.upstream?.host ?? "main";
      const host = provider.hosts[hostKey];
      if (host === undefined) {
        throw new ProviderDescriptionError(provider.type, `operation "${operation.name}" names unknown host "${hostKey}"`);
      }
      if (operation.model.in === "path" && !partNames.has(operation.model.part)) {
        throw new ProviderDescriptionError(
          provider.type,
          `operation "${operation.name}" reads its model from {${operation.model.part}}, which its path does not have`,
        );
      }
      const closedLists: Record<string, ReadonlySet<string> | "any"> = {};
      for (const segment of template.segments) {
        if (segment.kind !== "multi") continue;
        const list = operation.multiSegment?.[segment.name];
        if (list === undefined) {
          throw new ProviderDescriptionError(
            provider.type,
            `operation "${operation.name}" has no closed list for {${segment.name}...}`,
          );
        }
        closedLists[segment.name] = list === "priced_models" ? "any" : new Set(list);
      }
      return { operation, template, upstream, host: hostKey, closedLists };
    });
  }

  match(method: string, rawPath: string, context: MatchContext = {}): MatchResult {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) return { kind: "refused", reason: "bad_path", detail: normalized.reason };
    const { segments } = normalized;

    const gateway = this.refusedAt(method, { host: "main", paths: [segments.map(literal)] });
    if (gateway !== null) return { kind: "refused", reason: "refused_path", pattern: gateway };

    const route = context.route ?? DIRECT_ROUTE;
    for (const listed of context.passthrough ?? []) {
      if (listed.listed.method !== method) continue;
      const parts = matchTemplate(listed.template, segments);
      if (parts === null) continue;
      // Refused paths are judged again where the request really goes.
      const refused = this.refusedAt(method, upstreamTargets(route, "main", segments.map(literal)));
      if (refused !== null) return { kind: "refused", reason: "refused_path", pattern: refused };
      return { kind: "passthrough", listed: listed.listed, parts, upstream: { host: "main", path: joinSegments(segments) } };
    }

    for (const compiled of this.operations) {
      if (compiled.operation.match.method !== method) continue;
      const parts = matchTemplate(compiled.template, segments, { closedLists: compiled.closedLists });
      if (parts === null) continue;
      const path = compiled.upstream === null ? joinSegments(segments) : fillTemplate(compiled.upstream, parts);
      if (path === null) return { kind: "refused", reason: "bad_path", detail: "dot_segment" };
      // A declared operation is never a refused path: only how its route adds
      // a prefix is judged, not each way a base URL may be mounted. A base
      // URL whose own path looks like a refused one (`.../user/42/`) still
      // serves every operation, as it always did.
      const sent = normalizePath(path);
      const refused = sent.ok ? this.refusedAt(method, upstreamTargets({ ...route, basePath: null }, compiled.host, sent.segments.map(literal))) : null;
      if (refused !== null) return { kind: "refused", reason: "refused_path", pattern: refused };
      return { kind: "operation", operation: compiled.operation, parts, upstream: { host: compiled.host, path } };
    }

    return { kind: "refused", reason: "not_declared" };
  }

  /**
   * The first refused path that takes every path of one of `targets` (a
   * `{name}` part stands for any value), or null. Only the main host has
   * refused paths: the others serve declared operations only.
   */
  private refusedAt(method: string, targets: UpstreamTargets | null): string | null {
    if (targets === null || targets.host !== "main") return null;
    for (const path of targets.paths) {
      const segments = path.map((segment) =>
        segment.kind === "literal" ? segment.value : segment.kind === "part" ? segment.prefix + ANY_VALUE + segment.suffix : ANY_VALUE,
      );
      for (const { template, methods } of this.refused) {
        if (methods !== null && !methods.has(method)) continue;
        if (matchTemplate(template, segments, { ignoreCase: true }) !== null) return methods === null ? template.source : `${[...methods].join(",")} ${template.source}`;
      }
    }
    return null;
  }

  /**
   * The refused path that takes every request a listed path could match on
   * `route`, whatever its parts hold, at the gateway or where the request
   * goes, or null. Such a listing could never be reached: refused paths are
   * checked first, on both. One that takes only some of them is not
   * reported, for the same reason.
   */
  refusedCovering(listed: CompiledPassthrough, route: UpstreamRoute = DIRECT_ROUTE): string | null {
    const { method } = listed.listed;
    const gateway = this.refusedAt(method, { host: "main", paths: [listed.template.segments] });
    return gateway ?? this.refusedAt(method, upstreamTargets(route, "main", listed.template.segments));
  }

  /**
   * The first declared operation, of the listing's method, whose requests a
   * listed path could also take on `route`, or null. Listed paths are matched
   * before declared operations (plan section 4.5), so any overlap would let a
   * listing take a declared operation's requests unmetered: saving refuses
   * it. They overlap when some gateway path matches both, or when some path
   * the provider reads matches both upstream targets (`upstreamTargets`): a
   * listing's, and the operation's upstream path on its host. A `{name...}`
   * part with a closed list overlaps only through a value on that list; the
   * priced-models list through any value.
   */
  overlappingOperation(listed: CompiledPassthrough, route: UpstreamRoute = DIRECT_ROUTE): string | null {
    const mine = listed.template.segments as readonly SegmentPattern[];
    const sent = upstreamTargets(route, "main", mine);
    for (const compiled of this.operations) {
      if (compiled.operation.match.method !== listed.listed.method) continue;
      if (templatesMeet(mine, compiled.template.segments, compiled.closedLists)) return compiled.operation.name;
      const theirs = upstreamTargets(route, compiled.host, (compiled.upstream ?? compiled.template).segments);
      if (sent === null || theirs === null || theirs.host !== sent.host) continue;
      for (const path of sent.paths) {
        if (theirs.paths.some((other) => templatesMeet(path as readonly SegmentPattern[], other, compiled.closedLists))) {
          return compiled.operation.name;
        }
      }
    }
    return null;
  }

  /**
   * Where a declared operation is sent when the gateway builds the request
   * itself (a preset, or a rewritten model in the path), with `parts` filling
   * its template's parts. Null for an operation this provider does not
   * declare, a part `parts` leaves out, a `{name...}` value with an empty
   * segment, or a path that comes out with a dot segment.
   */
  upstreamFor(operationName: string, parts: Parts): UpstreamTarget | null {
    const compiled = this.operations.find((candidate) => candidate.operation.name === operationName);
    if (compiled === undefined) return null;
    const template = compiled.upstream ?? compiled.template;
    for (const segment of template.segments) {
      if (segment.kind === "rest") return null;
      if ((segment.kind === "part" || segment.kind === "multi") && !Object.hasOwn(parts, segment.name)) return null;
      // A `{name...}` value keeps its `/`s, but never an empty segment.
      if (segment.kind === "multi" && parts[segment.name]!.split("/").includes("")) return null;
    }
    const path = fillTemplate(template, parts);
    return path === null ? null : { host: compiled.host, path };
  }

  /** The names of an operation's template parts, or null when this provider does not declare it. */
  templateParts(operationName: string): readonly string[] | null {
    const compiled = this.operations.find((candidate) => candidate.operation.name === operationName);
    if (compiled === undefined) return null;
    return compiled.template.segments.flatMap((segment) => (segment.kind === "part" || segment.kind === "multi" ? [segment.name] : []));
  }
}

/** Whether some path matches both a listed path (no `{name...}` part) and an operation's path, read with its closed lists. */
function templatesMeet(listed: readonly SegmentPattern[], pattern: readonly TemplateSegment[], closedLists: ClosedLists): boolean {
  const multiAt = pattern.findIndex((segment) => segment.kind === "multi");
  const meetAll = (theirs: readonly TemplateSegment[], at: number) =>
    theirs.every((segment, index) => segment.kind !== "multi" && segment.kind !== "rest" && segmentsMeet(listed[at + index]!, segment));
  if (multiAt === -1) return pattern.length === listed.length && meetAll(pattern, 0);
  const before = pattern.slice(0, multiAt);
  const after = pattern.slice(multiAt + 1);
  const middle = listed.length - before.length - after.length;
  if (middle < 1 || !meetAll(before, 0) || !meetAll(after, listed.length - after.length)) return false;
  const name = (pattern[multiAt] as Extract<TemplateSegment, { kind: "multi" }>).name;
  const list = closedLists[name];
  if (list === undefined) return false;
  // Any value fills the middle segments: each listed segment has some value.
  if (list === "any") return true;
  for (const value of list) {
    const pieces = value.split("/");
    if (pieces.length !== middle) continue;
    if (pieces.every((piece, index) => segmentsMeet(listed[before.length + index]!, { kind: "literal", value: piece }))) return true;
  }
  return false;
}
