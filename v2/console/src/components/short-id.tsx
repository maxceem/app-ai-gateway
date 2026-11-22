import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * A long identifier shortened to its two ends, `7CHxeN…eQu2`: enough to tell
 * rows apart and to match a value you already have.
 */
export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * Shortened identifiers that open their full values: a button, so a keyboard
 * reaches it as well as a pointer, labelled with the full values for a screen
 * reader. The panel it opens stays open while you select or copy a value.
 */
export function FullIds({ ids, children }: { ids: { label: string; value: string }[]; children: ReactNode }) {
  if (!ids.some((id) => shortId(id.value) !== id.value)) return <>{children}</>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ids.map((id) => `${id.label} ${id.value}`).join(", ")}
          className="block cursor-pointer rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="text-xs select-text">
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
          {ids.map((id) => (
            <FullId key={id.label} label={id.label} value={id.value} />
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function FullId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The "copied" tick resets after a moment; never after the panel is gone.
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the value and copy it manually.");
    }
  };
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
      <dd>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="rounded-sm p-0.5 opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </dd>
    </>
  );
}
