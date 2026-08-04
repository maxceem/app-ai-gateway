import { useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Tag-style editor for `allowed_models`-shaped string arrays. */
export function StringList({
  values,
  onChange,
  placeholder,
  suggestions = [],
  warn,
  warnTitle,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  warn?: (value: string) => boolean;
  warnTitle?: string;
}) {
  const [draft, setDraft] = useState("");
  const listId = `suggestions-${Math.abs(hash(suggestions.join(",") + placeholder))}`;

  const add = (raw: string) => {
    const value = raw.trim();
    if (!value || values.includes(value)) return setDraft("");
    onChange([...values, value]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    }
    if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };

  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value) => {
            const flagged = warn?.(value) ?? false;
            return (
              <span
                key={value}
                title={flagged ? warnTitle : undefined}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border py-1 pr-1 pl-2 font-mono text-xs",
                  flagged
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : "bg-muted/50",
                )}
              >
                {value}
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  onClick={() => onChange(values.filter((item) => item !== value))}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          value={draft}
          list={suggestions.length > 0 ? listId : undefined}
          placeholder={placeholder}
          className="h-8 font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {suggestions.length > 0 ? (
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        ) : null}
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => add(draft)}>
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
    </div>
  );
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}
