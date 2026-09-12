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
import {
  ENTITLEMENT_FIELD_LABEL,
  ENTITLEMENT_PRESETS,
  REVENUECAT_CLAIM_PATH,
  revenueCatClaim,
  revenueCatEntitlement,
  type PresetInput,
} from "@/lib/presets";

const CHECKS = ENTITLEMENT_PRESETS.filter(
  (preset): preset is typeof preset & { id: EntitlementCheck } => preset.id !== "none",
);

/** The default claim the paid check starts from: RevenueCat, entitlement unnamed. */
export const DEFAULT_PAID_CLAIM: ClaimRequirement = revenueCatClaim("");

/**
 * Which claim says a user has paid. RevenueCat is one claim at one known path,
 * so it asks for the one thing only the operator knows — which entitlement; a
 * custom check is whatever claims the operator writes, so it opens the full
 * editor. Both write `required_claims`; the check is remembered so the same
 * form reopens.
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
  const entitlement = revenueCatEntitlement(claims);
  /*
   * Which form was filled in. The stored label is the console's own record of
   * that, and it is believed; a block written before the label existed is read
   * off its claim instead, which names RevenueCat's path when that is what it
   * checks. Either way the claims still have to be a shape the one-field form
   * can hold — anything richer belongs in the editor, whatever it is labelled.
   */
  const chosen = issuer.entitlement
    ?? (claims[0]?.path === REVENUECAT_CLAIM_PATH ? "revenuecat" : "custom");
  const check: EntitlementCheck =
    chosen === "revenuecat" && entitlement !== null ? "revenuecat" : "custom";
  const selected = CHECKS.find((preset) => preset.id === check) ?? CHECKS[0]!;

  const choose = (next: EntitlementCheck) => {
    if (next === check) return;
    // A RevenueCat check is exactly one claim at one path; whatever was there
    // is replaced by the shape it expects, keeping an entitlement id already
    // typed. Going custom keeps the claims as they are, to be edited freely.
    onChange({
      entitlement: next,
      required_claims: next === "revenuecat" ? [revenueCatClaim(entitlement ?? "")] : claims,
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="entitlement-check">{ENTITLEMENT_FIELD_LABEL}</Label>
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
        {selected.description ? (
          <p className="text-xs text-muted-foreground">{selected.description}</p>
        ) : null}
      </div>

      {check === "revenuecat" ? (
        <RevenueCatEntitlement
          input={selected.inputs[0]!}
          entitlement={entitlement ?? ""}
          disabled={disabled}
          onChange={(next) => onChange({ required_claims: [revenueCatClaim(next)] })}
        />
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

/**
 * The one thing a RevenueCat check needs, asked for with the same words the
 * creation wizard uses: the label, placeholder and hint all come off the preset
 * rather than being written twice and drifting apart.
 */
function RevenueCatEntitlement({
  input,
  entitlement,
  disabled,
  onChange,
}: {
  input: PresetInput;
  entitlement: string;
  disabled: boolean;
  onChange: (entitlement: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="entitlement-value">{input.label}</Label>
      <Input
        id="entitlement-value"
        value={entitlement}
        placeholder={input.placeholder}
        className="max-w-[320px] font-mono text-xs"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {input.hint}
        {input.docs ? (
          <>
            {" "}
            <ExternalHint href={input.docs.href}>{input.docs.label}</ExternalHint>
          </>
        ) : null}
      </p>
    </div>
  );
}
