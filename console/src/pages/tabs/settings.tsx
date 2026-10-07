import { useState } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, SectionHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import type { AppDraft } from "@/hooks/use-app-draft";
import { clientApiOrigin } from "@/lib/client-api";
import { authIssuer } from "@/lib/config-types";
import { useConsoleSession } from "@/lib/console-session";
import { useDeleteApp } from "@/lib/queries";

/**
 * The app as a record: what it is called, its id and the URL clients reach it
 * at, whether it is on, and the way to remove it. Nothing here changes how
 * requests are handled, which is why it sits apart from the sections that do.
 */
export function SettingsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const draft = state.draft!;
  const realtime = { enabled: false, max_session_seconds: 1800, max_concurrent_sessions: 10, max_concurrent_sessions_per_identity: 2, ...draft.config.realtime };
  const navigate = useNavigate();
  const deleteApp = useDeleteApp();
  const { readOnly, capabilities } = useConsoleSession();
  const issuer = authIssuer(draft.config.authentication);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(appId);
      setCopied(true);
      toast.success("Application id copied");
    } catch {
      toast.error("Could not copy the application id");
    }
  };

  const remove = async () => {
    try {
      const result = await deleteApp.mutateAsync(appId);
      toast.success(`Deleted ${draft.name}`, {
        description: `${result.removed_users} users removed. Usage history was kept.`,
      });
      // The page asks before a navigation loses unsaved changes; there is
      // nothing left to save them to. Cleared synchronously so the guard sees
      // it before the navigation it would otherwise stop.
      flushSync(() => state.reset());
      navigate("/apps");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the app");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><SectionHeader title="Realtime sessions" /></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div><p className="text-sm font-medium">Enable realtime WebSockets</p><p className="text-xs text-muted-foreground">Direct OpenAI Realtime with manual turns or managed VAD. Each admitted generation is one request. Gemini Live is pending conformance.</p></div>
            <Switch aria-label="Enable realtime WebSockets" checked={realtime.enabled} disabled={readOnly} onCheckedChange={enabled => state.updateConfig({ realtime: { ...realtime, enabled } })} />
          </div>
          {realtime.enabled && <div className="grid gap-4 sm:grid-cols-3">
            {([['max_session_seconds', 'Session duration (seconds)', 1800], ['max_concurrent_sessions', 'Concurrent sessions per app', 100], ['max_concurrent_sessions_per_identity', 'Concurrent sessions per identity', 10]] as const).map(([key, label, max]) => <Field key={key} label={label} htmlFor={`realtime-${key}`}><Input id={`realtime-${key}`} type="number" min={1} max={max} disabled={readOnly} value={realtime[key]} onChange={event => state.updateConfig({ realtime: { ...realtime, [key]: Number(event.target.value) } })} /></Field>)}
          </div>}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-5">
          <Field label="Name" htmlFor="app-name">
            <Input
              id="app-name"
              value={draft.name}
              maxLength={100}
              disabled={readOnly}
              className="max-w-md"
              onChange={(event) => state.update({ name: event.target.value })}
            />
          </Field>
          <Field label="Application id">
            <div className="flex items-center gap-1">
              <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{appId}</code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                aria-label="Copy application id"
                onClick={() => void copyId()}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </div>
          </Field>
          <Field label="Client base URL">
            <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
              {clientApiOrigin(capabilities)}/v1/apps/{appId}/proxy/&#123;provider&#125;/&#123;provider_path&#125;
            </code>
            <p className="text-xs text-muted-foreground">
              {issuer ? (
                <>
                  Auth exchange lives at{" "}
                  <span className="font-mono">/v1/apps/{appId}/auth/token</span>.
                </>
              ) : (
                <>
                  Clients send their API key as the{" "}
                  <span className="font-mono">Authorization</span> bearer credential; this app has no
                  token exchange.
                </>
              )}
            </p>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">App enabled</p>
              <p className="text-xs text-muted-foreground">
                Turned off, this app refuses every request. Nothing is deleted, and turning it back
                on restores it as it was.
              </p>
            </div>
            <Switch
              aria-label="App enabled"
              checked={draft.status === "active"}
              disabled={readOnly}
              onCheckedChange={(checked) =>
                state.update({ status: checked ? "active" : "disabled" })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <SectionHeader
            title="Delete this app"
            description="Clients of this app stop working immediately. Registered users and App Attest keys are removed. Usage history is kept for accounting."
            action={
              <GuardedButton
                variant="destructive"
                size="sm"
                disabled={deleteApp.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                Delete app
              </GuardedButton>
            }
          />
        </CardHeader>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${draft.name}?`}
        description={
          <>
            <p>
              Clients of this app stop working immediately. Registered users and App Attest keys are
              removed; usage history is kept for accounting.
            </p>
            <p>This cannot be undone.</p>
          </>
        }
        confirmWord={appId}
        confirmLabel="Delete app"
        destructive
        pending={deleteApp.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
