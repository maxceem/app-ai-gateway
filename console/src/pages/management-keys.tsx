import { useState } from "react";
import { AlertCircle, Plus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { formatDateTime } from "@/lib/format";
import {
  useCreateManagementKey,
  useManagementKeys,
  useRevokeManagementKey,
} from "@/lib/queries";
import type { CreatedManagementKey, ManagementKey } from "@/lib/types";

export function ManagementKeysPage() {
  const list = useManagementKeys();
  const createKey = useCreateManagementKey();
  const revokeKey = useRevokeManagementKey();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedManagementKey | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ManagementKey | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const result = await createKey.mutateAsync(name.trim());
      setCreating(false);
      setName("");
      setCreated(result.key);
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
      <PageHeader
        title="Management keys"
        description="Management keys let you manage everything in this console through the API — from CI, scripts, or an AI agent."
        action={
          <GuardedButton
            size="sm"
            onClick={() => {
              setName("");
              setCreating(true);
            }}
          >
            <Plus className="size-4" />
            New key
          </GuardedButton>
        }
      />

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load management keys</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : null}

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

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="Create a management key"
        description="Name it after whatever will use it, so you can tell keys apart when it is time to revoke one."
        submitLabel="Create key"
        pending={createKey.isPending}
        disabled={!name.trim()}
        onSubmit={() => void create()}
      >
        <Field label="Key name" htmlFor="management-key-name">
          <Input
            id="management-key-name"
            value={name}
            placeholder="CI deploy"
            maxLength={100}
            autoFocus
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </FormDialog>

      <SecretRevealDialog
        open={created !== null}
        title="Copy your new key now"
        description={
          <>
            This is the only time the plaintext for{" "}
            <span className="font-medium text-foreground">{created?.name}</span> is available — you
            will not see it again. The gateway stores only a hash.
          </>
        }
        label="Management key"
        secret={created?.plaintext ?? ""}
        footnote="Store it in your secret manager. It acts with full authority inside this organization."
        onAcknowledge={() => {
          setCreated(null);
          // The plaintext also sits in the mutation's cached result; drop it
          // so the only copy of a live credential is the operator's.
          createKey.reset();
        }}
      />

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
