import { AlertTriangle } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Field } from "@/components/field";
import type { AppAttestEnvironment } from "@/lib/config-types";

const ENVIRONMENTS: { value: AppAttestEnvironment; label: string; hint: string }[] = [
  {
    value: "production",
    label: "Production",
    hint: "Builds signed for TestFlight and the App Store.",
  },
  {
    value: "development",
    label: "Development",
    hint: "Builds run from Xcode, which attest in Apple's development environment.",
  },
];

/**
 * Apple stamps which of its two environments produced an attestation, and an
 * application accepts production unless it says otherwise. The opt-in is per
 * application rather than a global switch because a development build is
 * debuggable on any device carrying the team's provisioning profile — which is
 * why it belongs on a development bundle id and not the one you ship.
 *
 * `value` is the resolved list, so it is never empty; the caller decides whether
 * production-only is worth storing.
 */
export function AppAttestEnvironments({
  value,
  onChange,
  compact = false,
  disabled = false,
}: {
  value: AppAttestEnvironment[] | undefined;
  onChange: (next: AppAttestEnvironment[]) => void;
  disabled?: boolean;
  /**
   * Only the two choices, without the hint and the warning. For the creation
   * wizard, where each step asks one question and answers it as briefly as
   * it can; the settings page keeps the fuller explanation.
   */
  compact?: boolean;
}) {
  const selected = value ?? ["production"];
  const developmentEnabled = selected.includes("development");

  const toggle = (environment: AppAttestEnvironment, checked: boolean) => {
    const next = ENVIRONMENTS
      .map((entry) => entry.value)
      .filter((entry) => (entry === environment ? checked : selected.includes(entry)));
    // At least one, always: an empty list accepts no attestation at all, which
    // would lock every client out rather than restrict anything.
    if (next.length === 0) return;
    onChange(next);
  };

  return (
    <Field
      label="iOS app environment"
      hint={
        compact
          ? undefined
          : "Which of Apple's two environments this app accepts attestations from. Removing one also stops the keys it already registered."
      }
    >
      <div className="space-y-2">
        {ENVIRONMENTS.map((environment) => {
          const checked = selected.includes(environment.value);
          return (
            <div key={environment.value} className="flex items-start gap-2.5">
              <Checkbox
                id={`env-${environment.value}`}
                checked={checked}
                // The last remaining environment cannot be unchecked, and saying
                // so up front beats a click that silently does nothing.
                disabled={disabled || (checked && selected.length === 1)}
                onCheckedChange={(next) => toggle(environment.value, next === true)}
              />
              <div className="-mt-0.5">
                <Label htmlFor={`env-${environment.value}`} className="text-sm font-normal">
                  {environment.label}
                </Label>
                <p className="text-xs text-muted-foreground">{environment.hint}</p>
              </div>
            </div>
          );
        })}
        {developmentEnabled && !compact ? (
          <p className="flex items-start gap-2 rounded-md bg-amber-500/[0.08] p-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Any device carrying your team's provisioning profile can attest against this app.
              Keep this on a development bundle id rather than the one you ship.
            </span>
          </p>
        ) : null}
      </div>
    </Field>
  );
}
