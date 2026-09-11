import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClaimsEditor } from "@/components/claims-editor";
import { ExternalHint } from "@/components/external-hint";
import { PresetName } from "@/components/preset-picker";
import type { AuthConfig, ClaimRequirement, EntitlementCheck } from "@/lib/config-types";
import { ENTITLEMENT_PRESETS } from "@/lib/presets";

const CHECKS = ENTITLEMENT_PRESETS.filter(
  (preset): preset is typeof preset & { id: EntitlementCheck } => preset.id !== "none",
);

/** The default claim the paid check starts from: the RevenueCat convention. */
export const DEFAULT_PAID_CLAIM: ClaimRequirement = { path: "entitlements", contains: "" };

/**
 * Which claim says a user has paid. RevenueCat is one claim with a known shape,
 * asked for as two fields; a custom check is whatever claims the operator
 * writes, so it opens the full editor. Both write `required_claims`; the check
 * is remembered so the same form reopens.
 */
export function SubscriptionFields({
  issuer,
  disabled = false,
  onChange,
}: {
  issuer: AuthConfig;
  disabled?: boolean;
  onChange: (partial: Partial<AuthConfig>) => void;
}) {
  const claims = issuer.required_claims ?? [];
  const check: EntitlementCheck = issuer.entitlement ?? "custom";
  const selected = CHECKS.find((preset) => preset.id === check) ?? CHECKS[0]!;

  const choose = (next: EntitlementCheck) => {
    if (next === check) return;
    // A RevenueCat check is exactly one claim; whatever was there is replaced
    // by the shape it expects. Going custom keeps the claims as they are.
    onChange({
      entitlement: next,
      required_claims: next === "revenuecat" ? [DEFAULT_PAID_CLAIM] : claims,
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="entitlement-check">Paid check</Label>
        <Select value={check} disabled={disabled} onValueChange={(next) => choose(next as EntitlementCheck)}>
          <SelectTrigger id="entitlement-check" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHECKS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <PresetName preset={preset} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{selected.description}</p>
      </div>

      {check === "revenuecat" ? (
        <RevenueCatClaim claim={claims[0] ?? DEFAULT_PAID_CLAIM} disabled={disabled} onChange={(claim) => onChange({ required_claims: [claim] })} />
      ) : (
        <ClaimsEditor
          claims={claims}
          disabled={disabled}
          onChange={(next) => onChange({ required_claims: next })}
        />
      )}
    </div>
  );
}

function RevenueCatClaim({
  claim,
  disabled,
  onChange,
}: {
  claim: ClaimRequirement;
  disabled: boolean;
  onChange: (claim: ClaimRequirement) => void;
}) {
  const value = Array.isArray(claim.contains) ? claim.contains.join(", ") : (claim.contains ?? "");
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="entitlement-path">Claim path</Label>
          <Input
            id="entitlement-path"
            value={claim.path}
            placeholder="entitlements"
            className="font-mono text-xs"
            disabled={disabled}
            onChange={(event) => onChange({ path: event.target.value, contains: claim.contains ?? "" })}
          />
          <p className="text-xs text-muted-foreground">
            Where your backend writes the entitlement onto the sign-in token.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="entitlement-value">Entitlement id</Label>
          <Input
            id="entitlement-value"
            value={value}
            placeholder="pro"
            className="font-mono text-xs"
            disabled={disabled}
            onChange={(event) => onChange({ path: claim.path, contains: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The entitlement identifier from your{" "}
            <ExternalHint href="https://www.revenuecat.com/docs/getting-started/entitlements">
              RevenueCat project
            </ExternalHint>
            .
          </p>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        The gateway never talks to RevenueCat. Your backend receives its webhook and writes this
        claim onto the user&apos;s sign-in token; the gateway only checks that the claim is there.
      </p>
    </>
  );
}
