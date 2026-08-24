import { useState } from "react";
import { AlertCircle, Check, Copy, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { formatDateTime } from "@/lib/format";
import {
  useCreateManagementKey,
  useManagementKeys,
  useRevokeManagementKey,
} from "@/lib/queries";
import type { CreatedManagementKey, ManagementKey } from "@/lib/types";

export function ManagementKeysPage() {
  const { readOnly } = useConsoleSession();
  const list = useManagementKeys();
  const createKey = useCreateManagementKey();
  const revokeKey = useRevokeManagementKey();

  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedManagementKey | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ManagementKey | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const result = await createKey.mutateAsync(name.trim());
      setCreated(result.key);
      setName("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the key");
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    try {
      await revokeKey.mutateAsync(pendingRevoke.id);
      toast.success("Management key revoked");
      setPendingRevoke(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the key");
    }
  };

  const keys = list.data?.keys ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">Management keys</h1>
          <p className="text-sm text-muted-foreground">
            Organization-scoped <code className="font-mono text-xs">agw_mgmt_</code> credentials for
            scripts and CI. They act with full authority inside this organization.
          </p>
        </div>
      </div>

      {created ? <OneTimeKey created={created} onDismiss={() => setCreated(null)} /> : null}

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load management keys</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex max-w-lg gap-2">
        <Input
          value={name}
          placeholder="Key name, e.g. CI deploy"
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <GuardedButton disabled={!name.trim() || createKey.isPending} onClick={() => void create()}>
          {createKey.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Create key
        </GuardedButton>
      </div>

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1, 2].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  No management keys yet.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="tabular text-muted-foreground">
                    {formatDateTime(key.createdAt)}
                  </TableCell>
                  <TableCell>
                    {key.revokedAt ? (
                      <span className="text-muted-foreground">
                        Revoked {formatDateTime(key.revokedAt)}
                      </span>
                    ) : (
                      <span className="text-foreground">Active</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {key.revokedAt ? null : (
                      <GuardedButton
                        variant="outline"
                        size="sm"
                        onClick={() => setPendingRevoke(key)}
                      >
                        Revoke
                      </GuardedButton>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title="Revoke management key"
        description={
          <p>
            Anything using <span className="font-medium text-foreground">{pendingRevoke?.name}</span>{" "}
            will immediately lose access. This cannot be undone.
          </p>
        }
        confirmLabel="Revoke key"
        destructive
        pending={revokeKey.isPending}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}

/**
 * The plaintext token exists only in this response. The panel stays until
 * dismissed so a copy failure is recoverable, and says so explicitly.
 */
function OneTimeKey({
  created,
  onDismiss,
}: {
  created: CreatedManagementKey;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      toast.success("Key copied to clipboard");
    } catch {
      toast.error("Could not copy. Select the value and copy it manually.");
    }
  };

  return (
    <Alert>
      <AlertTitle>Copy your new key now — you will not see it again</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          This is the only time the plaintext for{" "}
          <span className="font-medium text-foreground">{created.name}</span> is available. The
          gateway stores only a hash.
        </p>
        <div className="flex w-full items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-nowrap text-foreground">
            {created.plaintext}
          </code>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={onDismiss}>
            <X className="size-4" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
