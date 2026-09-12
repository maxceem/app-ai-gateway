import { Braces, ExternalLink, TriangleAlert } from "lucide-react";
import { AuthBrandIcon, isAuthBrand } from "@/components/brand-icon";
import { ExternalHint } from "@/components/external-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EntitlementPreset, IssuerPreset, PresetInput } from "@/lib/presets";
import { cn } from "@/lib/utils";

type Preset = IssuerPreset | EntitlementPreset;

export function PresetPicker<T extends Preset>({
  label,
  presets,
  selected,
  values,
  onSelect,
  onValueChange,
  idPrefix,
  compact = false,
  disabled = false,
}: {
  label: string;
  presets: T[];
  selected: T;
  values: Record<string, string>;
  onSelect: (preset: T) => void;
  onValueChange: (key: string, value: string) => void;
  idPrefix: string;
  /** Leaves out the preset's warning and note, for a wizard step that asks one thing. */
  compact?: boolean;
  disabled?: boolean;
}) {
  const warning = !compact && "warning" in selected ? selected.warning : undefined;
  const note = !compact && "note" in selected ? selected.note : undefined;
  const docs = "docs" in selected ? selected.docs : undefined;
  const vendor = selected.vendor ?? selected.label;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-preset`}>{label}</Label>
        <Select
          value={selected.id}
          disabled={disabled}
          onValueChange={(next) => {
            const preset = presets.find((entry) => entry.id === next);
            if (preset) onSelect(preset);
          }}
        >
          <SelectTrigger id={`${idPrefix}-preset`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presets.map((preset) => (
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

      {selected.inputs.map((input: PresetInput) => (
        <div key={input.key} className="space-y-2">
          <Label htmlFor={`${idPrefix}-${input.key}`}>{input.label}</Label>
          <Input
            id={`${idPrefix}-${input.key}`}
            value={values[input.key] ?? ""}
            placeholder={input.placeholder}
            className="font-mono text-xs"
            disabled={disabled}
            onChange={(event) => onValueChange(input.key, event.target.value)}
          />
          {input.hint || input.docs ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {input.hint}
              {input.docs ? (
                <>
                  {input.hint ? " " : null}
                  <ExternalHint href={input.docs.href}>{input.docs.label}</ExternalHint>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ))}

      {warning ? (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ) : null}

      {note ? <p className="text-xs leading-relaxed text-muted-foreground">{note}</p> : null}

      {docs ? (
        <a
          href={docs}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {vendor} documentation
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

/**
 * A preset's name led by its vendor's mark, the way a provider is named
 * everywhere else in the console.
 *
 * The two bring-your-own presets — a custom issuer, a custom claim — name no
 * vendor, so they lead with braces: the glyph for a token you bring yourself,
 * in the row's own colour rather than a brand's, because there is no brand.
 * Only "no entitlement check" is text alone, since it is an absence rather
 * than something to bring.
 */
export function PresetName({ preset, className }: { preset: Preset; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {isAuthBrand(preset.id) ? <AuthBrandIcon type={preset.id} /> : null}
      {preset.id === "custom" ? (
        <Braces aria-hidden className="size-[1.15em] shrink-0 text-current" strokeWidth={1.8} />
      ) : null}
      {preset.label}
    </span>
  );
}
