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
 * 3. Declared operations, in the order the provider lists them.
 * 4. Passthrough paths the customer listed for this connection.
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
  /** Fixed `{name...}` lists. `priced_models` lists come from the caller. */
  readonly fixedLists: Readonly<Record<string, ReadonlySet<string>>>;
  readonly pricedParts: readonly string[];
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
    return { listed, template: parseTemplate(listed.path) };
  });
}

export interface MatchContext {
  /** The connection's listed passthrough paths, from `compilePassthrough`. */
  readonly passthrough?: readonly CompiledPassthrough[];
  /** The models priced for an operation, for its `priced_models` list. */
  readonly pricedModels?: (operation: string) => ReadonlySet<string>;
}

const NOTHING: ReadonlySet<string> = new Set();

export class ProviderMatcher {
  readonly provider: ProviderDescription;
  private readonly refused: readonly Template[];
  private readonly operations: readonly CompiledOperation[];

  /**
   * Compiles every template once. Throws on a broken description, so a test
   * that builds every provider's matcher catches it before deploy.
   *
   * `extraRefused` adds another provider's refused paths, for a custom
   * provider whose host belongs to a built-in one.
   */
  constructor(provider: ProviderDescription, extraRefused: readonly string[] = []) {
    this.provider = provider;
    this.refused = [...provider.refused, ...extraRefused].map((pattern) =>
      parseTemplate(pattern, { rest: true }),
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
      const fixedLists: Record<string, ReadonlySet<string>> = {};
      const pricedParts: string[] = [];
      for (const segment of template.segments) {
        if (segment.kind !== "multi") continue;
        const list = operation.multiSegment?.[segment.name];
        if (list === undefined) {
          throw new ProviderDescriptionError(
            provider.type,
            `operation "${operation.name}" has no closed list for {${segment.name}...}`,
          );
        }
        if (list === "priced_models") pricedParts.push(segment.name);
        else fixedLists[segment.name] = new Set(list);
      }
      return { operation, template, upstream, host: hostKey, fixedLists, pricedParts };
    });
  }

  match(method: string, rawPath: string, context: MatchContext = {}): MatchResult {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) return { kind: "refused", reason: "bad_path", detail: normalized.reason };
    const { segments } = normalized;

    for (const pattern of this.refused) {
      if (matchTemplate(pattern, segments, { ignoreCase: true }) !== null) {
        return { kind: "refused", reason: "refused_path", pattern: pattern.source };
      }
    }

    for (const compiled of this.operations) {
      if (compiled.operation.match.method !== method) continue;
      const parts = matchTemplate(compiled.template, segments, { closedLists: this.closedLists(compiled, context) });
      if (parts === null) continue;
      return {
        kind: "operation",
        operation: compiled.operation,
        parts,
        upstream: {
          host: compiled.host,
          path: compiled.upstream === null ? joinSegments(segments) : fillTemplate(compiled.upstream, parts),
        },
      };
    }

    for (const listed of context.passthrough ?? []) {
      if (listed.listed.method !== method) continue;
      const parts = matchTemplate(listed.template, segments);
      if (parts === null) continue;
      return { kind: "passthrough", listed: listed.listed, parts, upstream: { host: "main", path: joinSegments(segments) } };
    }

    return { kind: "refused", reason: "not_declared" };
  }

  private closedLists(compiled: CompiledOperation, context: MatchContext): ClosedLists {
    if (compiled.pricedParts.length === 0) return compiled.fixedLists;
    const priced = context.pricedModels?.(compiled.operation.name) ?? NOTHING;
    const lists: Record<string, ReadonlySet<string>> = { ...compiled.fixedLists };
    for (const name of compiled.pricedParts) lists[name] = priced;
    return lists;
  }
}
