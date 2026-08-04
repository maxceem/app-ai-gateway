import { Badge } from "@/components/ui/badge";
import type { UsageStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AppStatusBadge({ status }: { status: "active" | "disabled" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        status === "active"
          ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
          : "border-muted-foreground/30 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "active" ? "bg-emerald-500" : "bg-muted-foreground",
        )}
      />
      {status}
    </Badge>
  );
}

const EVENT_TONES: Record<UsageStatus, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  provider_error: "border-destructive/40 text-destructive",
  blocked_rate: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_budget: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  blocked_user: "border-amber-500/40 text-amber-600 dark:text-amber-400",
};

export function EventStatusBadge({ status }: { status: UsageStatus }) {
  return (
    <Badge variant="outline" className={cn("font-mono text-[11px] font-normal", EVENT_TONES[status])}>
      {status}
    </Badge>
  );
}

export function UserStatusBadge({ status }: { status: "active" | "blocked" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "blocked"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      {status}
    </Badge>
  );
}
