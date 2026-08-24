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
import { currentMonth, formatCompact, formatCost, formatNumber, formatRelative, totalTokens } from "@/lib/format";
import { useUserAction, useUsers } from "@/lib/queries";
import type { GatewayUser } from "@/lib/types";

const PAGE_SIZE = 25;

export function UsersTab({ appId }: { appId: string }) {
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
            placeholder="Search user id"
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
            <SelectItem value="all">All users</SelectItem>
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
              <TableHead>User</TableHead>
              <TableHead>Attestation</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
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
                  No users yet. A row appears once a client completes its first token exchange.
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
                    {user.attest_registered ? (
                      <div className="flex items-center gap-1.5">
                        <Badge variant="secondary" className="text-[11px] font-normal">
                          {user.attest_env ?? "production"}
                        </Badge>
                        <span className="tabular text-[11px] text-muted-foreground">
                          counter {user.attest_counter}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {user.is_virtual ? "server attributed" : "dev access"}
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
                  <TableCell className="tabular text-right">{formatCost(user.usage.cost_usd)}</TableCell>
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
          {formatNumber(total)} users · page {page + 1} of {pages}
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
