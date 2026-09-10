import { cn } from "@/lib/utils";

export interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

/**
 * One question, several answers, exactly one chosen. Plain radio rows rather
 * than cards: the answers are short and the question is asked once, so there
 * is nothing for a border to separate.
 *
 * `describedBy` names the reason the list cannot be operated, for a read-only
 * member, so assistive tech announces the question and then why it is inert.
 */
export function ChoiceList<T extends string>({
  label,
  choices,
  value,
  disabled = false,
  describedBy,
  onChange,
}: {
  label: string;
  choices: Choice<T>[];
  value: T | null;
  disabled?: boolean;
  describedBy?: string;
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} className="space-y-1">
      {choices.map((choice) => {
        const selected = choice.value === value;
        return (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
            className={cn(
              "flex w-full items-start gap-3.5 rounded-lg px-3 py-3 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              disabled ? "cursor-not-allowed opacity-60" : "hover:bg-muted/50",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                selected ? "border-primary" : "border-muted-foreground/50",
              )}
            >
              {selected ? <span className="size-2.5 rounded-full bg-primary" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{choice.label}</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {choice.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
