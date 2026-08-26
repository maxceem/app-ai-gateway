import { useState } from "react";
import { Check, Clipboard, KeyRound, Loader2, Plus, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
 * only ever presented to the token exchange, never to the proxy.
 */
export function ServerKeys({ appId, exchanged = false }: { appId: string; exchanged?: boolean }) {
  const keys = useApiKeys(appId);
  const create = useCreateApiKey(appId);
  const revoke = useRevokeApiKey(appId);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  const createKey = async () => {
    try {
      const result = await create.mutateAsync(name);
      setCreated(result);
      setName("");
      setCopied(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the API key");
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      toast.success("API key copied");
    } catch {
      toast.error("Could not copy the API key");
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
      {created ? (
        <Alert>
          <KeyRound />
          <AlertTitle>Copy this API key now</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>The plaintext key is shown once and cannot be recovered after this notice is closed.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">
                {created.key}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                Hide
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Server API keys</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {exchanged
              ? "Tenant backends send one of these keys with an issuer token to the auth exchange and use the gateway token it returns; the key itself is rejected on proxy requests, and Last used follows the traffic those tokens make. Revoking stops the next exchange at once, though tokens already minted stay valid for up to an hour."
              : "Tenant backends send one of these keys as an Authorization bearer credential. Revoking takes effect within a minute."}{" "}
            Store it as a secret and rotate it by creating a replacement before revoking the old
            key.
          </p>
          <div className="flex max-w-lg gap-2">
            <Input
              value={name}
              maxLength={100}
              placeholder="Production Worker"
              onChange={(event) => setName(event.target.value)}
            />
            <GuardedButton disabled={!name.trim() || create.isPending} onClick={() => void createKey()}>
              {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create key
            </GuardedButton>
          </div>

          <div className="overflow-hidden rounded-md border">
            <Table>
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
    </div>
  );
}
