import { useRef, type KeyboardEvent } from "react";
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
 *
 * Keyboard behaviour is the WAI-ARIA radio group's: the group is one tab stop
 * (the chosen answer, or the first when none is), and the arrow keys, Home and
 * End move both focus and the choice, wrapping at either end.
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
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = choices.findIndex((choice) => choice.value === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = choices.length - 1;
    const target =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    onChange(choices[target]!.value);
  };

  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} className="space-y-1">
      {choices.map((choice, index) => {
        const selected = choice.value === value;
        return (
          <button
            key={choice.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(choice.value)}
            onKeyDown={(event) => move(event, index)}
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
