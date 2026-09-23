/**
 * The small pieces the providers and gateways screens and their dialogs share:
 * the cells that say how a row authenticates, the badge a paused row carries,
 * the field attributes a credential input needs, and the two sentences a
 * deletion has to be able to explain.
 *
 * Nothing here holds state or fetches anything. Each section and each dialog is
 * a file of its own beside this one; this is what several of them say the same
 * way, and saying it twice is what this folder exists to avoid.
 */

import { Link } from "react-router-dom";
import { AlertCircle, CircleCheck, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { GatewayIcon } from "@/components/brand-icon";
import type { TestOutcome } from "@/lib/provider-probe";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Browsers ignore `autocomplete="off"` on anything that looks like a sign-in
 * form: a text input next to a password input is heuristically username +
 * password, so the operator's own saved site credentials get filled into a
 * provider name and its API key. `new-password` is the value Chrome and Safari
 * actually honour, and the `data-*` opt-outs cover 1Password and LastPass.
 */
const NO_AUTOFILL = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
};

/** Text fields that sit beside a credential and must not be read as a username. */
export const PLAIN_FIELD = { autoComplete: "off", ...NO_AUTOFILL };

/** Every field that accepts a provider credential. */
export const SECRET_FIELD = {
  type: "password",
  autoComplete: "new-password",
  spellCheck: false,
  ...NO_AUTOFILL,
} as const;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Anchors the gateways section's row for a gateway, so a provider can link to it. */
export const gatewayAnchor = (id: string) => `gateway-${id}`;

/** The gateways section's own path, which the providers table links into. */
export const GATEWAYS_PATH = "/providers/gateways";

/**
 * Why this gateway cannot be deleted, mirroring the API's `gateway_in_use`
 * message. Disabled rows are kept for re-enabling and still hold the foreign
 * key, so a gateway serving no traffic can still be undeletable — saying
 * "active" there would be a lie the operator cannot act on.
 */
export function deleteBlockedReason(gateway: ProviderGateway): string | undefined {
  if (gateway.referencedCount === 0) return undefined;
  if (gateway.providerCount === 0) {
    return "Disabled provider instances still reference this gateway; delete them to release it";
  }
  return gateway.referencedCount > gateway.providerCount
    ? "Delete the active and disabled provider instances routed through this gateway first"
    : "Delete every active provider instance routed through this gateway first";
}

/** One labelled thing a row authenticates with, beside its siblings. */
export function AuthLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      {label}: <span className="font-mono text-xs">{value}</span>
    </div>
  );
}

/**
 * How the instance authenticates, in the one form an operator recognises: the
 * tail of its own key, or the name of the gateway whose key stands in for it.
 * Neither the gateway's ids nor the full key are usable here — the name is what
 * the operator named it, and the hint is all of the key there ever is.
 *
 * A custom origin rides along with the key, because it is the single most
 * surprising thing about an instance: the key alone would hide which service it
 * is actually being sent to.
 */
export function Auth({ row, gateways }: { row: ProviderCredential; gateways: ProviderGateway[] }) {
  if (row.providerGatewayId === null) {
    return (
      <div className="space-y-0.5">
        {row.secretHint === null
          ? <div>API key</div>
          : <AuthLine label="API key" value={`…${row.secretHint}`} />}
        {row.baseUrl === null ? null : <AuthLine label="Base URL" value={row.baseUrl} />}
      </div>
    );
  }
  const gateway = gateways.find((entry) => entry.id === row.providerGatewayId);
  // The list is still loading, or the gateway is gone: the row is routed either
  // way, and that is more honest than an empty cell.
  if (!gateway) return <>Gateway</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      Gateway:
      <GatewayIcon type={gateway.type} />
      <Link
        className="text-primary-ink underline underline-offset-4"
        to={`${GATEWAYS_PATH}#${gatewayAnchor(gateway.id)}`}
      >
        {gateway.name}
      </Link>
    </span>
  );
}

/**
 * Everything the gateway is addressed and admitted by, labelled. What addresses
 * it is per type — Cloudflare's account and gateway pair, against a Vercel
 * gateway whose origin is fixed in adapter code and so has nothing to show —
 * and the key is only ever its last four characters.
 */
export function GatewayAuth({ gateway }: { gateway: ProviderGateway }) {
  return (
    <div className="space-y-0.5">
      {gateway.type === "cf_aig" ? (
        <>
          <AuthLine label="Account ID" value={gateway.config.accountId} />
          <AuthLine label="Gateway ID" value={gateway.config.gatewayId} />
        </>
      ) : null}
      <AuthLine label="API key" value={`…${gateway.secretHint}`} />
    </div>
  );
}

/** The muted marker a paused instance carries everywhere it is listed. */
export function DisabledBadge() {
  return (
    <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground">
      disabled
    </Badge>
  );
}

/**
 * The apps that name a slug outright, from the apps list's own
 * `referenced_providers`. All-mode apps are deliberately absent: they reach
 * every instance without naming any, so listing them here would name every app
 * the organization has for every provider and say nothing.
 */
export function ReferencingApps({ slug, names }: { slug: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <p>
      <span className="font-medium text-foreground">{names.join(", ")}</span>{" "}
      {names.length === 1 ? "names" : "name"}{" "}
      <span className="font-mono text-foreground">{slug}</span> in its configuration.
    </p>
  );
}

const TEST_STYLES = {
  works: {
    icon: CircleCheck,
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  unconfirmed: { icon: Info, className: "bg-muted text-muted-foreground" },
  failed: { icon: AlertCircle, className: "bg-destructive/10 text-destructive" },
} as const;

export function TestResult({ outcome }: { outcome: TestOutcome }) {
  const { icon: Icon, className } = TEST_STYLES[outcome.status];
  return (
    <p
      // The operator pressed a button and is waiting for this line to appear.
      aria-live="polite"
      className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-xs", className)}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      {outcome.message}
    </p>
  );
}
