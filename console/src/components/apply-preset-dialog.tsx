import { useMemo, useState } from "react";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { PresetPicker, PresetPreview } from "@/components/preset-picker";
import type { AuthConfig } from "@/lib/config-types";
import {
  ENTITLEMENT_PRESETS,
  ISSUER_PRESETS,
  buildEntitlement,
  buildIssuer,
  describeClaim,
  mergeClaims,
  presetInputsComplete,
  type EntitlementPreset,
  type IssuerPreset,
} from "@/lib/presets";

/**
 * Same presets as app creation, applied to an existing policy. Claims are merged
 * by path, so hand-written requirements survive and re-applying updates rather
 * than duplicates.
 */
export function ApplyPresetDialog({
  auth,
  onApply,
}: {
  auth: AuthConfig;
  onApply: (partial: Partial<AuthConfig>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [issuer, setIssuer] = useState<IssuerPreset>(ISSUER_PRESETS[0]!);
  const [issuerValues, setIssuerValues] = useState<Record<string, string>>({});
  const [entitlement, setEntitlement] = useState<EntitlementPreset>(ENTITLEMENT_PRESETS[0]!);
  const [entitlementValues, setEntitlementValues] = useState<Record<string, string>>({});

  const fragment = useMemo(() => {
    const built = buildIssuer(issuer, issuerValues);
    return {
      ...built,
      required_claims: mergeClaims(
        built.required_claims,
        buildEntitlement(entitlement, entitlementValues),
      ),
    };
  }, [issuer, issuerValues, entitlement, entitlementValues]);

  const presetsComplete =
    presetInputsComplete(issuer, issuerValues) && presetInputsComplete(entitlement, entitlementValues);
  const ready = presetsComplete && fragment.jwks_url.startsWith("https://");

  const apply = () => {
    onApply({
      jwks_url: fragment.jwks_url,
      user_id_claim: auth.user_id_claim ?? fragment.user_id_claim,
      required_claims: mergeClaims(auth.required_claims ?? [], fragment.required_claims),
    });
    setOpen(false);
    toast.success(`Applied the ${issuer.label} preset`, {
      description: "Review the claims below, then save.",
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Wand2 className="size-3.5" />
          Apply preset
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Apply an issuer preset</DialogTitle>
          <DialogDescription>
            Overwrites the JWKS URL and adds the provider&rsquo;s identifying claims. Existing
            requirements on other claim paths are kept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <PresetPicker
            label="Identity provider"
            idPrefix="apply-issuer"
            presets={ISSUER_PRESETS}
            selected={issuer}
            values={issuerValues}
            onSelect={(preset) => {
              setIssuer(preset);
              setIssuerValues({});
            }}
            onValueChange={(key, value) =>
              setIssuerValues((current) => ({ ...current, [key]: value }))
            }
          />
          <Separator />
          <PresetPicker
            label="Entitlement requirement"
            idPrefix="apply-entitlement"
            presets={ENTITLEMENT_PRESETS}
            selected={entitlement}
            values={entitlementValues}
            onSelect={(preset) => {
              setEntitlement(preset);
              setEntitlementValues(preset.id === "revenuecat" ? { path: "entitlements" } : {});
            }}
            onValueChange={(key, value) =>
              setEntitlementValues((current) => ({ ...current, [key]: value }))
            }
          />
          {presetsComplete ? (
            <PresetPreview
              fragment={{
                jwks_url: fragment.jwks_url,
                claims: fragment.required_claims.map(describeClaim),
              }}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={apply}>
            Apply to draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
