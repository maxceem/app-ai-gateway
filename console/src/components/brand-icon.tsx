import anthropic from "@/assets/brands/anthropic.svg?raw";
import baseten from "@/assets/brands/baseten.svg?raw";
import bytedance from "@/assets/brands/bytedance.svg?raw";
import cerebras from "@/assets/brands/cerebras.svg?raw";
import cfAig from "@/assets/brands/cf_aig.svg?raw";
import deepseek from "@/assets/brands/deepseek.svg?raw";
import fireworks from "@/assets/brands/fireworks.svg?raw";
import gemini from "@/assets/brands/gemini.svg?raw";
import groq from "@/assets/brands/groq.svg?raw";
import huggingface from "@/assets/brands/huggingface.svg?raw";
import mistral from "@/assets/brands/mistral.svg?raw";
import moonshot from "@/assets/brands/moonshot.svg?raw";
import openai from "@/assets/brands/openai.svg?raw";
import openrouter from "@/assets/brands/openrouter.svg?raw";
import perplexity from "@/assets/brands/perplexity.svg?raw";
import together from "@/assets/brands/together.svg?raw";
import vercel from "@/assets/brands/vercel.svg?raw";
import xai from "@/assets/brands/xai.svg?raw";
import { GATEWAY_TYPE_LABELS, PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import type { ProviderGatewayType } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Classes on the mark itself, not only on its wrapper. Menu and select items
 * restyle every `svg` they contain — `size-4` unless it already carries a
 * `size-` class, `text-muted-foreground` unless it already carries a `text-`
 * one — and a brand mark is neither theirs to resize nor theirs to grey out.
 * Carrying both prefixes opts out of both rules and says what it wants instead.
 */
const MARK_CLASS = "size-full text-current";

function classed(svg: string): string {
  // Trimmed: the file's own trailing newline would otherwise land in the DOM as
  // a text node beside the mark, and turn up in every label read off it.
  return svg.trim().replace("<svg", `<svg class="${MARK_CLASS}"`);
}

function marks<Key extends string>(sources: Record<Key, string>): Record<Key, string> {
  return Object.fromEntries(
    Object.entries<string>(sources).map(([key, svg]) => [key, classed(svg)]),
  ) as Record<Key, string>;
}

/**
 * The mark for every provider type, keyed by the type itself. `Record` rather
 * than `Partial<Record>` on purpose: a provider type added to the shared
 * capability matrix stops typechecking here until it has a mark of its own,
 * which is what keeps "every provider is shown with its brand" true of the
 * whole list rather than of the entries somebody remembered.
 */
const PROVIDER_MARKS: Record<Provider, string> = marks({
  openai,
  anthropic,
  xai,
  gemini,
  perplexity,
  deepseek,
  groq,
  mistral,
  together,
  fireworks,
  cerebras,
  moonshot,
  huggingface,
  baseten,
  bytedance,
  openrouter,
});

/** The same, for the gateways a provider instance can be routed through. */
const GATEWAY_MARKS: Record<ProviderGatewayType, string> = marks({
  cf_aig: cfAig,
  vercel,
});

/**
 * A vendored SVG, inlined rather than pointed at through `<img>`: half of these
 * marks are single-colour and painted with `currentColor`, which is what lets
 * them read on a light and a dark background alike — and an `<img>` has no
 * surrounding colour to inherit.
 *
 * Sized in `em` so the mark tracks whatever text it was set beside, from a
 * table cell down to a badge, without every caller picking a number.
 *
 * Always `aria-hidden`: every caller renders the brand's name next to the mark,
 * so anything announced here would be a second copy of it.
 */
function Mark({ svg, className }: { svg: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-[1.15em] shrink-0", className)}
      // Static, bundled assets: the only strings that reach this are the files
      // in `assets/brands`, and nothing user-supplied can become one.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function ProviderIcon({ type, className }: { type: Provider; className?: string }) {
  return <Mark svg={PROVIDER_MARKS[type]} className={className} />;
}

export function GatewayIcon({ type, className }: { type: ProviderGatewayType; className?: string }) {
  return <Mark svg={GATEWAY_MARKS[type]} className={className} />;
}

/**
 * The mark and the name together, which is how a brand is named everywhere in
 * this console. The mark never stands alone: it makes a name recognisable at a
 * glance, and a logo on its own would make the reader identify one to read a
 * table cell.
 */
export function ProviderName({ type, className }: { type: Provider; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <ProviderIcon type={type} />
      {PROVIDER_LABELS[type]}
    </span>
  );
}

export function GatewayName({ type, className }: { type: ProviderGatewayType; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <GatewayIcon type={type} />
      {GATEWAY_TYPE_LABELS[type]}
    </span>
  );
}
