import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * "App [AI] Gateway" — the mark sits inline between the words, so the gap is
 * word spacing rather than the wider mark-beside-text gap.
 */
export function Brand({ className, onClick }: { className?: string; onClick?: () => void }) {
  return (
    <Link
      to="/apps"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md text-sm font-semibold tracking-tight",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <span>App</span>
      <span className="grid size-6 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
        AI
      </span>
      <span>Gateway</span>
    </Link>
  );
}
