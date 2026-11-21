/**
 * Matches a request to a declared operation or a listed passthrough path.
 * Closed by default: anything else is refused.
 *
 * The order is fixed (plan sections 4.1 and 4.5):
 *
 * 1. Normalize the path. A path that could mean something else upstream is
 *    refused.
 * 2. The provider's refused paths, ignoring case. These win even over a path
 *    the customer listed. Its live-session token paths (`liveTokens`) are
 *    refused the same way, except to a listed path that opts in to them
 *    (plan D4).
 * 3. Passthrough paths the customer listed for this connection. They come
 *    before declared operations, so a release that declares an operation
 *    for a listed path never switches it on its own: the customer makes
 *    that switch (plan section 4.5).
 * 4. Declared operations, in the order the provider lists them.
 * 5. Everything else is refused.
 *
 * Which operations an app allows is decided after this, by the app's settings.
 */
import type { HttpMethod, LiveTokenPath, OperationDescription, ProviderDescription } from "./operation.ts";
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
  /**
   * On a custom provider only: the built-in API style the path speaks
   * (`./custom.ts`). The path is then an operation of that style, metered by
   * its usage reader at the connection's rates, not a passthrough path.
   */
  readonly style?: string;
  /**
   * The path opts in to the provider's live-session token paths
   * (`liveTokens`, plan D4): without it they stay refused, even when listed.
   * Never written when false.
   */
  readonly liveToken?: true;
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
      /** The live-session token path it reaches, through the listing's opt-in, or null. */
      readonly liveToken: LiveTokenPath | null;
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
  /**
   * A base URL on Cloudflare AI Gateway's host
   * (`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai/`):
   * Cloudflare reads what follows its provider endpoint as the
   * `cloudflareGateway` setting does, so that reading is a target too. The
   * path after the endpoint, and the prefix Cloudflare adds back
   * (`cloudflarePrefix`'s rule). Absent otherwise.
   */
  readonly cloudflareBase?: { readonly after: readonly string[]; readonly prefix: readonly string[] };
  /**
   * The lower-cased host name of the connection's base URL, when it has one.
   * Refused paths that name hosts (`RefusedPath.hosts`) apply only there.
   */
  readonly baseHost?: string | null;
}

/** Cloudflare AI Gateway's host: a base URL on it is read as its provider endpoint reads paths. */
export const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";

/** Segments of Cloudflare AI Gateway's path before a provider's endpoint takes over: `v1`, the account, the gateway, the endpoint. */
const CLOUDFLARE_ENDPOINT_SEGMENTS = 4;

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
  // Cloudflare's provider endpoint adds this back: the one mapping, for the setting and for a base URL on its host.
  const cloudflarePrefix = (description.cloudflareGateway?.stripPathPrefix ?? "").split("/").filter((piece) => piece !== "");
  if (connection.cloudflareGateway !== null) return { basePath: null, cloudflarePrefix };
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
    const baseHost = url?.hostname.toLowerCase() ?? null;
    const cloudflareBase =
      baseHost === CLOUDFLARE_AI_GATEWAY_HOST ? { after: basePath.slice(CLOUDFLARE_ENDPOINT_SEGMENTS), prefix: cloudflarePrefix } : undefined;
    return {
      basePath,
      cloudflarePrefix: null,
      baseHost,
      ...(own !== undefined ? { hostPrefix: own.prefix } : {}),
      ...(cloudflareBase !== undefined ? { cloudflareBase } : {}),
    };
  }
  return DIRECT_ROUTE;
}

/** Where a path sent on a host reaches: the host, and each path the provider may read it as. */
export interface UpstreamTargets {
  /** A key of the provider's `hosts`. The main host stands for the base URL or Cloudflare too. */
  readonly host: string;
  readonly paths: readonly (readonly TemplateSegment[])[];
  /** The base URL's host name on the main host (`UpstreamRoute.baseHost`), for refused paths that name hosts. */
  readonly baseHost?: string | null;
}

/** The targets of `paths` on the main host of `route`, with its base URL's host. */
const mainTargets = (route: UpstreamRoute, paths: readonly (readonly TemplateSegment[])[]): UpstreamTargets =>
  route.baseHost === undefined || route.baseHost === null ? { host: "main", paths } : { host: "main", paths, baseHost: route.baseHost };

/**
 * How Cloudflare AI Gateway's provider endpoint reads `path`: it adds back
 * `prefix` (`stripPathPrefix`); a path that may or may not start with it (a
 * `{name}` part there) is read both ways.
 */
function cloudflareReadings(prefix: readonly string[], path: readonly TemplateSegment[]): (readonly TemplateSegment[])[] {
  if (prefix.length === 0) return [path];
  const added = [...prefix.map(literal), ...path];
  const head = path.slice(0, prefix.length);
  const starts = head.length === prefix.length && head.every((segment, index) => segment.kind === "literal" && segment.value === prefix[index]);
  if (starts) return [path];
  const may =
    head.length === prefix.length &&
    head.every((segment, index) => (segment.kind === "literal" || segment.kind === "part") && segmentsMeet(segment, { kind: "literal", value: prefix[index]! }));
  return may ? [path, added] : [added];
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
  if (prefix !== null) return mainTargets(route, cloudflareReadings(prefix, path));
  const base = route.basePath;
  if (base === null) return mainTargets(route, [path]);
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
  // A base URL on Cloudflare AI Gateway's host: read as the setting reads it.
  const cloudflare = route.cloudflareBase;
  if (cloudflare !== undefined) paths.push(...cloudflareReadings(cloudflare.prefix, [...cloudflare.after.map(literal), ...path]));
  return mainTargets(route, paths);
}

export interface MatchContext {
  /** The connection's listed passthrough paths, from `compilePassthrough`. */
  readonly passthrough?: readonly CompiledPassthrough[];
  /** The connection's route (`upstreamRoute`). Direct when left out. */
  readonly route?: UpstreamRoute;
}

/** A refused or live-session token path, compiled: its template, and the methods it covers, or null for every method. */
interface CompiledRule<Entry> {
  readonly template: Template;
  readonly methods: ReadonlySet<string> | null;
  /** The base URL hosts it applies on (`RefusedPath.hosts`), or null for every route. */
  readonly hosts?: ReadonlySet<string> | null;
  readonly entry: Entry;
}

/** What a rule reports a refusal as: its template, after its methods when it names some. */
function ruleSource(rule: CompiledRule<unknown>): string {
  return rule.methods === null ? rule.template.source : `${[...rule.methods].join(",")} ${rule.template.source}`;
}

export class ProviderMatcher {
  readonly provider: ProviderDescription;
  private readonly refused: readonly CompiledRule<null>[];
  private readonly liveTokens: readonly CompiledLiveToken[];
  private readonly operations: readonly CompiledOperation[];

  /**
   * Compiles every template once. Throws on a broken description, so a test
   * that builds every provider's matcher catches it before deploy.
   */
  constructor(provider: ProviderDescription) {
    this.provider = provider;
    this.refused = provider.refused.map((entry) =>
      typeof entry === "string"
        ? { template: parseTemplate(entry, { rest: true }), methods: null, entry: null }
        : {
            template: parseTemplate(entry.path, { rest: true }),
            methods: entry.methods === undefined ? null : new Set(entry.methods),
            hosts: entry.hosts === undefined ? null : new Set(entry.hosts.map((host) => host.toLowerCase())),
            entry: null,
          },
    );
    // Every method under the path is refused; the opt-in reaches only the mint.
    this.liveTokens = (provider.liveTokens ?? []).map((entry) => ({
      template: parseTemplate(entry.path, { rest: true }),
      methods: null,
      entry,
      mint: parseTemplate(entry.mint ?? (entry.path.endsWith("/*") ? entry.path.slice(0, -2) : entry.path)),
    }));
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

    const route = context.route ?? DIRECT_ROUTE;
    const atGateway = mainTargets(route, [segments.map(literal)]);
    const gateway = this.refusedAt(method, atGateway);
    if (gateway !== null) return { kind: "refused", reason: "refused_path", pattern: gateway };
    // A live-session token path is refused like the others unless a listed path that opts in takes the request.
    const gatewayToken = firstRule(this.liveTokens, method, atGateway);

    // A token path a listing reached without opting in to its mint: refused,
    // unless a later listing that opts in takes the request.
    let tokenRefusal: string | null = null;
    for (const listed of context.passthrough ?? []) {
      if (listed.listed.method !== method) continue;
      const parts = matchTemplate(listed.template, segments);
      if (parts === null) continue;
      // Refused paths are judged again where the request really goes.
      const sent = upstreamTargets(route, "main", segments.map(literal));
      const refused = this.refusedAt(method, sent);
      if (refused !== null) return { kind: "refused", reason: "refused_path", pattern: refused };
      const token = this.tokenRule(method, atGateway, sent);
      // The opt-in reaches only the mint itself; anything else under a token path stays refused.
      if (token !== null && (listed.listed.liveToken !== true || !token.mint)) {
        tokenRefusal ??= ruleSource(token.rule);
        continue;
      }
      return {
        kind: "passthrough",
        listed: listed.listed,
        parts,
        upstream: { host: "main", path: joinSegments(segments) },
        liveToken: token === null ? null : token.rule.entry,
      };
    }
    if (tokenRefusal !== null) return { kind: "refused", reason: "refused_path", pattern: tokenRefusal };
    if (gatewayToken !== null) return { kind: "refused", reason: "refused_path", pattern: ruleSource(gatewayToken) };

    for (const compiled of this.operations) {
      if (compiled.operation.match.method !== method) continue;
      const parts = matchTemplate(compiled.template, segments, { closedLists: compiled.closedLists });
      if (parts === null) continue;
      const path = compiled.upstream === null ? joinSegments(segments) : fillTemplate(compiled.upstream, parts);
      if (path === null) return { kind: "refused", reason: "bad_path", detail: "dot_segment" };
      // A declared operation is never a refused path: only how its route adds
      // a prefix is judged, not each way a base URL may be mounted. A base
      // URL whose own path looks like a refused one (`.../user/42/`) still
      // serves every operation, as it always did. A custom provider's
      // operations are paths its customer listed, judged as listings are.
      const sent = normalizePath(path);
      const judged = this.provider.customerPaths === true ? route : { ...route, basePath: null };
      const targets = sent.ok ? upstreamTargets(judged, compiled.host, sent.segments.map(literal)) : null;
      const refused = this.refusedAt(method, targets) ?? this.liveTokenAt(method, targets);
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
    const rule = firstRule(this.refused, method, targets);
    return rule === null ? null : ruleSource(rule);
  }

  /**
   * The live-session token path that takes a request at the gateway or where
   * it is sent (`upstreamTargets`), or null, and whether the request is its
   * mint. It is the mint only when every reading of its path that a token
   * path takes is exactly that token path's mint: a base URL that puts the
   * listed mint under the namespace (`v1/single-use-token/` with
   * `v1/single-use-token/tts_websocket`) reaches another path there, which
   * stays refused. Readings no token path takes do not count. Several token
   * paths may share one namespace, each with its own mint.
   */
  private tokenRule(method: string, atGateway: UpstreamTargets | null, sent: UpstreamTargets | null): { readonly rule: CompiledLiveToken; readonly mint: boolean } | null {
    let first: CompiledLiveToken | null = null;
    let minted: CompiledLiveToken | null = null;
    let every = true;
    for (const targets of [atGateway, sent]) {
      if (targets === null || targets.host !== "main") continue;
      for (const path of targets.paths) {
        const taking = [...everyRule(this.liveTokens, method, { host: "main", paths: [path] })];
        if (taking.length === 0) continue;
        first ??= taking[0]!;
        const mintOf = taking.find((rule) => mints(rule, method, { host: "main", paths: [path] }));
        if (mintOf === undefined) every = false;
        else minted ??= mintOf;
      }
    }
    if (first === null) return null;
    return minted !== null && every ? { rule: minted, mint: true } : { rule: minted ?? first, mint: false };
  }

  /** The first live-session token path that takes every path of one of `targets`, as `refusedAt`, or null. */
  private liveTokenAt(method: string, targets: UpstreamTargets | null): string | null {
    const rule = firstRule(this.liveTokens, method, targets);
    return rule === null ? null : ruleSource(rule);
  }

  /**
   * The refused path that takes every request a listed path could match on
   * `route`, whatever its parts hold, at the gateway or where the request
   * goes, or null. Such a listing could never be reached: refused paths are
   * checked first, on both. One that takes only some of them is not
   * reported, for the same reason. A live-session token path counts too,
   * unless the listing opts in to it.
   */
  refusedCovering(listed: CompiledPassthrough, route: UpstreamRoute = DIRECT_ROUTE): string | null {
    const { method } = listed.listed;
    const atGateway = mainTargets(route, [listed.template.segments]);
    const sent = upstreamTargets(route, "main", listed.template.segments);
    const refused = this.refusedAt(method, atGateway) ?? this.refusedAt(method, sent);
    if (refused !== null || listed.listed.liveToken === true) return refused;
    return this.liveTokenAt(method, atGateway) ?? this.liveTokenAt(method, sent);
  }

  /**
   * The live-session token path that takes every request a listed path could
   * match on `route`, as `refusedCovering` judges it, or null. A listing may
   * opt in to live-session tokens only when one takes all its requests.
   */
  liveTokenCovering(listed: CompiledPassthrough, route: UpstreamRoute = DIRECT_ROUTE): LiveTokenPath | null {
    const { method } = listed.listed;
    const atGateway = mainTargets(route, [listed.template.segments]);
    const sent = upstreamTargets(route, "main", listed.template.segments);
    const token = this.tokenRule(method, atGateway, sent);
    // Only a listing of the mint itself may opt in: its method, on exactly the token path, wherever it is read.
    if (token === null || !token.mint) return null;
    // Nor may any request it matches, for some value of its parts, land
    // under a token path elsewhere than that path's mint: serving refuses
    // those (`tokenRule`), so the listing would save and then not work.
    for (const targets of [atGateway, sent]) {
      if (targets === null || targets.host !== "main") continue;
      for (const path of targets.paths) {
        const reading: UpstreamTargets = { host: "main", paths: [path] };
        const meets = this.liveTokens.some((rule) => (rule.methods === null || rule.methods.has(method)) && ruleMeets(path, rule.template));
        // Token paths may share a namespace, each with its own mint.
        if (meets && !this.liveTokens.some((rule) => mints(rule, method, reading))) return null;
      }
    }
    return token.rule.entry;
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
    return this.overlappingOperations(listed, route)[0] ?? null;
  }

  /** Every declared operation a listed path could also take on `route`, in declared order (`overlappingOperation`). */
  overlappingOperations(listed: CompiledPassthrough, route: UpstreamRoute = DIRECT_ROUTE): readonly string[] {
    const mine = listed.template.segments as readonly SegmentPattern[];
    const sent = upstreamTargets(route, "main", mine);
    const found: string[] = [];
    for (const compiled of this.operations) {
      if (compiled.operation.match.method !== listed.listed.method) continue;
      if (templatesMeet(mine, compiled.template.segments, compiled.closedLists)) {
        found.push(compiled.operation.name);
        continue;
      }
      const theirs = upstreamTargets(route, compiled.host, (compiled.upstream ?? compiled.template).segments);
      if (sent === null || theirs === null || theirs.host !== sent.host) continue;
      if (sent.paths.some((path) => theirs.paths.some((other) => templatesMeet(path as readonly SegmentPattern[], other, compiled.closedLists)))) {
        found.push(compiled.operation.name);
      }
    }
    return found;
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

/**
 * The first rule that takes every path of one of `targets` (a `{name}` part
 * stands for any value), ignoring case, or null. Only the main host has
 * refused and live-session token paths: the others serve declared operations
 * only.
 */
/** A live-session token path, with its mint: its method on exactly its path, without the trailing `*`. */
interface CompiledLiveToken extends CompiledRule<LiveTokenPath> {
  readonly mint: Template;
}

/**
 * Whether every request of one of `targets` is the token path's mint: its
 * method, on exactly its path. A `{name}` part of a listing must take only
 * a value the mint's own part takes.
 */
function mints(rule: CompiledLiveToken, method: string, targets: UpstreamTargets | null): boolean {
  if (targets === null || targets.host !== "main" || method !== rule.entry.method) return false;
  return targets.paths.some((path) => matchTemplate(rule.mint, targetSegments(path), { ignoreCase: true }) !== null);
}

/**
 * Whether some request path matches both `path` (a listing's reading, whose
 * `{name}` parts take any value) and a refused or token rule's template,
 * which may end in `*` and is compared ignoring case.
 */
function ruleMeets(path: readonly TemplateSegment[], template: Template): boolean {
  const lower = (segment: TemplateSegment): TemplateSegment =>
    segment.kind === "literal"
      ? { kind: "literal", value: segment.value.toLowerCase() }
      : segment.kind === "part"
        ? { ...segment, prefix: segment.prefix.toLowerCase(), suffix: segment.suffix.toLowerCase() }
        : segment;
  const mine = path.map(lower);
  const theirs = template.segments.map(lower);
  const rest = theirs[theirs.length - 1]?.kind === "rest";
  const fixed = rest ? theirs.slice(0, -1) : theirs;
  if (rest ? mine.length < fixed.length : mine.length !== fixed.length) return false;
  return fixed.every((segment, index) => {
    const other = mine[index]!;
    if (segment.kind !== "literal" && segment.kind !== "part") return false;
    if (other.kind !== "literal" && other.kind !== "part") return true;
    return segmentsMeet(other, segment);
  });
}

/** A target path as literal segments, a `{name}` part standing for any value. */
function targetSegments(path: UpstreamTargets["paths"][number]): string[] {
  return path.map((segment) =>
    segment.kind === "literal" ? segment.value : segment.kind === "part" ? segment.prefix + ANY_VALUE + segment.suffix : ANY_VALUE,
  );
}

/** Every rule that takes every path of one of `targets`, in order, as `firstRule` finds them. */
function* everyRule<Rule extends CompiledRule<unknown>>(rules: readonly Rule[], method: string, targets: UpstreamTargets | null): Generator<Rule> {
  if (targets === null || targets.host !== "main") return;
  for (const path of targets.paths) {
    const segments = targetSegments(path);
    for (const rule of rules) {
      if (rule.methods !== null && !rule.methods.has(method)) continue;
      if (matchTemplate(rule.template, segments, { ignoreCase: true }) !== null) yield rule;
    }
  }
}

/** Whether a rule applies where `targets` go: a rule that names hosts only on a base URL on one of them. */
function appliesOn(rule: CompiledRule<unknown>, targets: UpstreamTargets): boolean {
  if (rule.hosts === undefined || rule.hosts === null) return true;
  return targets.baseHost !== undefined && targets.baseHost !== null && rule.hosts.has(targets.baseHost);
}

function firstRule<Rule extends CompiledRule<unknown>>(rules: readonly Rule[], method: string, targets: UpstreamTargets | null): Rule | null {
  if (targets === null || targets.host !== "main") return null;
  for (const path of targets.paths) {
    const segments = targetSegments(path);
    for (const rule of rules) {
      if (rule.methods !== null && !rule.methods.has(method)) continue;
      if (!appliesOn(rule, targets)) continue;
      if (matchTemplate(rule.template, segments, { ignoreCase: true }) !== null) return rule;
    }
  }
  return null;
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
