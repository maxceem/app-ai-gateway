import { useState } from "react";
import { AlertCircle, Ban, Plus } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { ChoiceList, type Choice } from "@/components/choice-list";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, PageHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { RowAction, RowActions } from "@/components/row-actions";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { useConsoleSession } from "@/lib/console-session";
import { formatDateTime } from "@/lib/format";
import {
  useCreateManagementKey,
  useManagementKeys,
  useRevokeManagementKey,
} from "@/lib/queries";
import type { CreatedManagementKey, ManagementKey } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Where a key came from, as a short tag and the sentence behind it.
 *
 * The gateway reports the source as a plain string, so a value this console
 * does not know yet is still shown, as itself, rather than hidden.
 */
const KEY_SOURCES: Record<string, { tag: string; title: string; cli: boolean }> = {
  console: { tag: "Console", title: "Created in this console", cli: false },
  cli: { tag: "CLI", title: "Issued to a CLI that was approved in a browser", cli: true },
  bootstrap: { tag: "CLI setup", title: "The key a CLI started this account with", cli: true },
};

type KeyGrant = ManagementKey["grant"];

/**
 * How much of the creator's role a key may use, as the create dialog offers it
 * and the list names it. `manage` first: it is the default, and what a key
 * for CI or the CLI needs.
 */
const KEY_GRANTS: Choice<KeyGrant>[] = [
  {
    value: "manage",
    label: "Manage",
    description: "Everything your role allows: create, change and delete apps, providers and keys.",
  },
  {
    value: "read",
    label: "Read only",
    description: "Lists and inspects apps, providers and usage, but cannot change them.",
  },
];

function KeyGrantBadge({ grant }: { grant: KeyGrant }) {
  const known = KEY_GRANTS.find((choice) => choice.value === grant);
  return (
    <Badge
      variant="outline"
      title={known?.description}
      className="text-[11px] font-normal text-muted-foreground"
    >
      {known?.label ?? grant}
    </Badge>
  );
}

function KeySourceBadge({ source }: { source: string }) {
  const known = KEY_SOURCES[source];
  return (
    <Badge
      variant="outline"
      title={known?.title}
      className={cn(
        "text-[11px] font-normal",
        known?.cli ? "border-primary/40 text-primary-ink" : "text-muted-foreground",
      )}
    >
      {known?.tag ?? source}
    </Badge>
  );
}

/**
 * An OAuth connection rather than a key: what an MCP client holds once a
 * person allowed it on the consent page, or continued without an account.
 * It is listed, and revoked, exactly like a key.
 */
function isConnection(key: ManagementKey): boolean {
  return key.credentialType === "oauth";
}

/**
 * The host that vouches for a connection's client: the one serving the
 * metadata document its https `client_id` names. Null for a client the
 * deployment registered itself, whose id is not a URL.
 */
export function clientDomain(clientId: string | null): string | null {
  if (!clientId) return null;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

function KindBadge({ connection }: { connection: boolean }) {
  return (
    <Badge
      variant="outline"
      title={
        connection
          ? "An MCP client connected with OAuth. Its token renews itself while the client uses it."
          : "A management key: a token you created or a CLI received"
      }
      className={cn(
        "text-[11px] font-normal",
        connection ? "border-primary/40 text-primary-ink" : "text-muted-foreground",
      )}
    >
      {connection ? "Connection" : "Key"}
    </Badge>
  );
}

/**
 * Who holds a credential. A connection's name is its client's own claim for
 * itself, so it is shown as plain text beside the domain that vouched for it,
 * never as anything a page could interpret.
 */
function HolderCell({ credential }: { credential: ManagementKey }) {
  if (isConnection(credential)) {
    const domain = clientDomain(credential.clientId);
    return (
      <>
        <p className="font-medium break-all">{credential.name}</p>
        <p className="text-xs text-muted-foreground break-all">
          {domain ? `as declared by ${domain}` : "Registered client"}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="font-medium">{credential.name}</p>
      {/* Who holds it, as the CLI described itself, when that says more than the name. */}
      {credential.label && credential.label !== credential.name ? (
        <p className="text-xs text-muted-foreground">{credential.label}</p>
      ) : null}
    </>
  );
}

/**
 * Access: everything that can manage this account without a browser session —
 * management keys, and the OAuth connections MCP clients hold — listed alike
 * and revoked alike.
 */
export function ManagementKeysPage() {
  const { organization } = useConsoleSession();
  const list = useManagementKeys();
  const createKey = useCreateManagementKey();
  const revokeKey = useRevokeManagementKey();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [grant, setGrant] = useState<KeyGrant>("manage");
  const [created, setCreated] = useState<CreatedManagementKey | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ManagementKey | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const result = await createKey.mutateAsync({ name: name.trim(), grant });
      setCreating(false);
      setName("");
      setGrant("manage");
      setCreated(result.key);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the key");
    }
  };

  const revoke = async () => {
    if (!pendingRevoke) return;
    const connection = isConnection(pendingRevoke);
    try {
      await revokeKey.mutateAsync(pendingRevoke.id);
      toast.success(connection ? "Connection revoked" : "Management key revoked");
      setPendingRevoke(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : connection ? "Could not revoke the connection" : "Could not revoke the key",
      );
    }
  };

  const keys = list.data?.keys ?? [];
  const pendingConnection = pendingRevoke !== null && isConnection(pendingRevoke);
  const accountName = (organizationId: string) =>
    organization?.id === organizationId ? organization.name : organizationId;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access"
        description="Management keys and connected MCP clients can manage everything in this console through the API — from CI, scripts, or an AI agent. Revoke any of them here."
        action={
          <GuardedButton
            size="sm"
            onClick={() => {
              setName("");
              setGrant("manage");
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
          <AlertTitle>Could not load keys and connections</AlertTitle>
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
              <TableHead>Kind</TableHead>
              <TableHead>Grant</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1, 2].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  No keys or connections yet.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => {
                const connection = isConnection(key);
                return (
                  <TableRow key={key.id}>
                    <TableCell className="max-w-64">
                      <HolderCell credential={key} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <KindBadge connection={connection} />
                        {connection ? null : <KeySourceBadge source={key.source} />}
                      </div>
                      {connection ? null : (
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {key.tokenHint === null ? "—" : `…${key.tokenHint}`}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <KeyGrantBadge grant={key.grant} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{accountName(key.organizationId)}</TableCell>
                    <TableCell className="tabular text-muted-foreground">
                      {formatDateTime(key.createdAt)}
                    </TableCell>
                    <TableCell className="tabular text-muted-foreground">
                      {/* A connection's end moves forward each time its client renews it. */}
                      {key.expiresAt ? formatDateTime(key.expiresAt) : "Never"}
                    </TableCell>
                    <TableCell>
                      {key.revokedAt ? (
                        <span className="text-muted-foreground">
                          Revoked {formatDateTime(key.revokedAt)}
                        </span>
                      ) : key.enabled ? (
                        <span className="text-foreground">Active</span>
                      ) : (
                        // Issued by an approval flow that has not handed it over
                        // yet, so it cannot sign a request even though it is here.
                        <span className="text-muted-foreground">Not yet active</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* A revoked credential has nothing left to act on, so it gets no menu. */}
                      {key.revokedAt ? null : (
                        <RowActions label={key.name}>
                          <RowAction destructive onSelect={() => setPendingRevoke(key)}>
                            <Ban />
                            {connection ? "Revoke connection" : "Revoke key"}
                          </RowAction>
                        </RowActions>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="Create a management key"
        submitLabel="Create key"
        pending={createKey.isPending}
        disabled={!name.trim()}
        onSubmit={() => void create()}
      >
        <Field
          label="Key name"
          htmlFor="management-key-name"
          hint="Name it so you can tell keys apart in the list."
        >
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
        <div className="space-y-1">
          <p className="text-sm font-medium">What may this key do?</p>
          <ChoiceList label="Key grant" choices={KEY_GRANTS} value={grant} onChange={setGrant} />
        </div>
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
        footnote={
          created?.grant === "read"
            ? "Store it in your secret manager. It can read every app and provider here, but cannot change them."
            : "Store it in your secret manager. It acts with full authority over every app and provider key here."
        }
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
        title={pendingConnection ? "Revoke connection" : "Revoke management key"}
        description={
          <p>
            {pendingConnection ? "The client " : "Anything using "}
            <span className="font-medium text-foreground">{pendingRevoke?.name}</span>{" "}
            {pendingConnection
              ? "will immediately lose access, and has to be connected again to get it back. This cannot be undone."
              : "will immediately lose access. This cannot be undone."}
          </p>
        }
        confirmLabel={pendingConnection ? "Revoke connection" : "Revoke key"}
        destructive
        pending={revokeKey.isPending}
        onConfirm={() => void revoke()}
      />
    </div>
  );
}
