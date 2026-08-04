import { ExternalLink, TriangleAlert } from "lucide-react";
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

type Preset = IssuerPreset | EntitlementPreset;

export function PresetPicker<T extends Preset>({
  label,
  presets,
  selected,
  values,
  onSelect,
  onValueChange,
  idPrefix,
}: {
  label: string;
  presets: T[];
  selected: T;
  values: Record<string, string>;
  onSelect: (preset: T) => void;
  onValueChange: (key: string, value: string) => void;
  idPrefix: string;
}) {
  const warning = "warning" in selected ? selected.warning : undefined;
  const note = "note" in selected ? selected.note : undefined;
  const docs = "docs" in selected ? selected.docs : undefined;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-preset`}>{label}</Label>
        <Select
          value={selected.id}
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
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{selected.description}</p>
      </div>

      {selected.inputs.map((input: PresetInput) => (
        <div key={input.key} className="space-y-2">
          <Label htmlFor={`${idPrefix}-${input.key}`}>{input.label}</Label>
          <Input
            id={`${idPrefix}-${input.key}`}
            value={values[input.key] ?? ""}
            placeholder={input.placeholder}
            className="font-mono text-xs"
            onChange={(event) => onValueChange(input.key, event.target.value)}
          />
          {input.hint ? <p className="text-xs text-muted-foreground">{input.hint}</p> : null}
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
          Provider documentation
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

/** Preview of exactly what the preset will write, so nothing is applied blind. */
export function PresetPreview({ fragment }: { fragment: { jwks_url?: string; claims: string[] } }) {
  if (!fragment.jwks_url && fragment.claims.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/40 p-3">
      <p className="text-xs font-medium">This writes</p>
      {fragment.jwks_url ? (
        <p className="font-mono text-[11px] break-all text-muted-foreground">
          jwks_url = {fragment.jwks_url}
        </p>
      ) : null}
      {fragment.claims.map((claim) => (
        <p key={claim} className="font-mono text-[11px] break-all text-muted-foreground">
          {claim}
        </p>
      ))}
    </div>
  );
}
