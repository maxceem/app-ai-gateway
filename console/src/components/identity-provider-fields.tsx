import { PresetPicker } from "@/components/preset-picker";
import type { AuthConfig } from "@/lib/config-types";
import { ISSUER_PRESETS, buildIssuer, matchIssuerPreset, type IssuerPreset } from "@/lib/presets";

/**
 * The identity provider form of the creation wizard, bound to a stored issuer.
 * The provider and its inputs are read back out of the block on every render
 * and every keystroke writes the block anew, so there is no second copy of the
 * answer to fall out of step with the draft: discarding the draft resets the
 * form, and the form always shows what would be saved.
 */
export function IdentityProviderFields({
  issuer,
  disabled = false,
  onChange,
}: {
  issuer: AuthConfig;
  disabled?: boolean;
  onChange: (partial: Partial<AuthConfig>) => void;
}) {
  const { preset, values } = matchIssuerPreset(issuer);

  const write = (nextPreset: IssuerPreset, nextValues: Record<string, string>) => {
    const fragment = buildIssuer(nextPreset, nextValues);
    onChange({
      provider: nextPreset.id,
      jwks_url: fragment.jwks_url,
      issuer: fragment.issuer,
      audience: fragment.audience,
      user_id_claim: issuer.user_id_claim ?? fragment.user_id_claim,
    });
  };

  return (
    <PresetPicker
      idPrefix="issuer"
      label="Identity provider"
      presets={ISSUER_PRESETS}
      selected={preset}
      values={values}
      compact
      disabled={disabled}
      onSelect={(next) => write(next, {})}
      onValueChange={(key, value) => write(preset, { ...values, [key]: value })}
    />
  );
}
