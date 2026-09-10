import { useState } from "react";
import { Plus, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { GuardedButton } from "@/components/guarded-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, SectionHeader } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelative } from "@/lib/format";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/lib/queries";
import type { CreatedApiKey } from "@/lib/types";

/**
 * `exchanged` mirrors the app's issuer setting: with one configured the key is
 * only ever presented to the token exchange, never to the proxy. `title` and
 * `description` let the card stand for the question it answers on the Auth policy
 * tab, where the keys are how a server application proves itself.
 */
export function ServerKeys({
  appId,
  exchanged = false,
  title = "Server API keys",
  description,
}: {
  appId: string;
  exchanged?: boolean;
  title?: string;
  description?: string;
}) {
  const keys = useApiKeys(appId);
  const create = useCreateApiKey(appId);
  const revoke = useRevokeApiKey(appId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  const createKey = async () => {
    if (!name.trim()) return;
    try {
      const result = await create.mutateAsync(name.trim());
      setCreating(false);
      setName("");
      setCreated(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the API key");
    }
  };

  const revokeKey = async (keyId: string) => {
    try {
      await revoke.mutateAsync(keyId);
      toast.success("API key revoked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the API key");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <SectionHeader
            title={title}
            description={description}
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
        </CardHeader>
        <CardContent className="space-y-4">
          {exchanged ? null : (
            <p className="text-xs text-muted-foreground">
              Your backend sends one of these keys as an Authorization bearer credential. Revoking
              takes effect within a minute.
            </p>
          )}

          <div className="overflow-hidden rounded-md border">
            <Table className="[--table-inset:1rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data?.keys.length ? (
                  keys.data.keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell>{key.name}</TableCell>
                      <TableCell className="font-mono text-xs">{key.key_prefix}…</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelative(key.last_used_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={key.status === "active" ? "secondary" : "outline"}>
                          {key.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <GuardedButton
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          disabled={key.status === "revoked" || revoke.isPending}
                          onClick={() => void revokeKey(key.id)}
                        >
                          <ShieldX className="size-3.5" />
                          Revoke
                        </GuardedButton>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No API keys yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <FormDialog
        open={creating}
        onOpenChange={setCreating}
        title="Create an API key"
        submitLabel="Create key"
        pending={create.isPending}
        disabled={!name.trim()}
        onSubmit={() => void createKey()}
      >
        <Field
          label="Key name"
          htmlFor="api-key-name"
          hint="Name it so you can tell keys apart in the list."
        >
          <Input
            id="api-key-name"
            value={name}
            placeholder="Production Worker"
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
        label="API key"
        secret={created?.key ?? ""}
        onAcknowledge={() => {
          setCreated(null);
          // The plaintext also sits in the mutation's cached result; drop it
          // so the only copy of a live credential is the operator's.
          create.reset();
        }}
      />
    </div>
  );
}
