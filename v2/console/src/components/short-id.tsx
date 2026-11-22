import { useState, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A long identifier shortened to its two ends, `7CHxeN…eQu2`: enough to tell
 * rows apart and to match a value you already have.
 */
export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * Shows the full identifiers behind shortened ones on hover. The tooltip stays
 * open while the pointer is inside it, so each value can be selected, or
 * copied with its button.
 */
export function FullIds({ ids, children }: { ids: { label: string; value: string }[]; children: ReactElement }) {
  if (!ids.some((id) => shortId(id.value) !== id.value)) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-none text-left select-text [text-wrap:wrap]">
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
          {ids.map((id) => (
            <FullId key={id.label} label={id.label} value={id.value} />
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}

function FullId({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy. Select the value and copy it manually.");
    }
  };
  return (
    <>
      <dt className="opacity-70">{label}</dt>
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
