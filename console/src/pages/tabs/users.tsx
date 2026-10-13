import { useState } from "react";
import { Ban, CircleCheck, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { MonthPicker } from "@/components/pickers";
import { UserStatusBadge } from "@/components/status-badge";
import { BudgetCell } from "@/components/budget";
import { currentMonth, formatCompact, formatCost, formatNumber, formatRelative, totalTokens } from "@/lib/format";
import { useUserAction, useUsers } from "@/lib/queries";
import type { GatewayUser } from "@/lib/types";

const PAGE_SIZE = 25;

export function UsersTab({
  appId,
  monthlyBudgetUsd,
  budgetScope = "user",
  appAttest = false,
  installsOnly = false,
}: {
  appId: string;
  /**
   * What each of this app's users may spend in a month, from the app's own
   * limits. One number for the whole table rather than a field per row: it is
   * the same ceiling for every user, and only the spend measured against it
   * differs. `null` is unlimited.
   */
  monthlyBudgetUsd: number | null;
  /**
   * Whose month `monthlyBudgetUsd` is measured over. A row is one user's
   * spend across every install they hold, so it is drawn against the budget
   * only where the budget is that user's — never one install's budget against
   * several installs' spend.
   */
  budgetScope?: "install" | "user";
  /** Whether users hold App Attest keys, one per install, whose count is shown. */
  appAttest?: boolean;
  /** Under app_install every user is one install, and is named as one. */
  installsOnly?: boolean;
}) {
  const noun = installsOnly ? "install" : "user";
  // Under app_install a user is one install, so an install budget is theirs.
  const budgetIsPerRow = budgetScope === "user" || installsOnly;
  const [month, setMonth] = useState(currentMonth());
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "blocked">("all");
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<GatewayUser | null>(null);

  const users = useUsers(appId, {
    month,
    query: search || undefined,
    status: status === "all" ? undefined : status,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const action = useUserAction(appId);

  const apply = async () => {
    if (!pending) return;
    const blocked = pending.status === "active";
    try {
      await action.mutateAsync({ userId: pending.id, blocked });
      toast.success(blocked ? `Blocked ${pending.id}` : `Unblocked ${pending.id}`, {
        description: blocked
          ? "Their Durable Object was updated, so it applies even to a live gateway token."
          : undefined,
      });
      setPending(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the user");
    }
  };

  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder={installsOnly ? "Search install id" : "Search user id"}
            className="h-9 pl-8 font-mono text-xs"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <Select
          value={status}
          onValueChange={(next) => {
            setStatus(next as typeof status);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-[140px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{installsOnly ? "All installs" : "All users"}</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="blocked">Blocked</SelectItem>
          </SelectContent>
        </Select>
        <MonthPicker value={month} onChange={setMonth} />
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{installsOnly ? "Install" : "User"}</TableHead>
              <TableHead>{appAttest && !installsOnly ? "Installs" : "Attestation"}</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Budget</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isPending ? (
              [0, 1, 2].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : users.data?.users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  No {noun}s yet. A row appears once a client completes its first token exchange.
                </TableCell>
              </TableRow>
            ) : (
              users.data?.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{user.id}</span>
                      {user.status === "blocked" ? <UserStatusBadge status="blocked" /> : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {appAttest && !installsOnly && user.installs > 0 ? (
                      <span className="tabular text-xs" title="App Attest keys this user holds: one per install">
                        {formatNumber(user.installs)}
                      </span>
                    ) : user.attest_registered ? (
                      <Badge variant="secondary" className="text-[11px] font-normal">
                        registered
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {user.is_virtual ? "server attributed" : "issuer token"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(user.last_seen_at)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatNumber(user.usage.requests)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatCompact(totalTokens(user.usage))}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {/* One user against the budget the app sets for each of
                        them, drawn exactly as the apps list draws an app
                        against its own. */}
                    {budgetIsPerRow ? (
                      <BudgetCell spent={user.usage.cost_usd} budget={monthlyBudgetUsd} />
                    ) : (
                      // The budget is each install's, and this is the sum of
                      // the user's installs: no single bar says where any of
                      // them stands, so the cost is shown on its own.
                      <span
                        className="whitespace-nowrap"
                        title={monthlyBudgetUsd === null
                          ? "No monthly budget"
                          : `Spent across this user's installs; the ${formatCost(monthlyBudgetUsd)} budget applies to each install`}
                      >
                        {formatCost(user.usage.cost_usd)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <GuardedButton
                      variant="ghost"
                      size="sm"
                      disabled={user.is_virtual}
                      onClick={() => setPending(user)}
                      className={user.status === "active" ? "text-destructive" : undefined}
                    >
                      {user.status === "active" ? (
                        <>
                          <Ban className="size-3.5" />
                          Block
                        </>
                      ) : (
                        <>
                          <CircleCheck className="size-3.5" />
                          Unblock
                        </>
                      )}
                    </GuardedButton>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {formatNumber(total)} {noun}s · page {page + 1} of {pages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= pages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.status === "active" ? `Block ${pending?.id}?` : `Unblock ${pending?.id}?`}
        description={
          pending?.status === "active" ? (
            <p>
              Their requests are refused immediately, even with an unexpired gateway token, because
              the block is written to their Durable Object as well as D1.
            </p>
          ) : (
            <p>Their requests resume as soon as the Durable Object is updated.</p>
          )
        }
        confirmLabel={pending?.status === "active" ? "Block user" : "Unblock user"}
        destructive={pending?.status === "active"}
        pending={action.isPending}
        onConfirm={() => void apply()}
      />
    </div>
  );
}
