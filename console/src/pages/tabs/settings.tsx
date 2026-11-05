import { useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ExternalHint } from "@/components/external-hint";
import { Field, SectionHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import type { AppDraft } from "@/hooks/use-app-draft";
import { clientApiOrigin } from "@/lib/client-api";
import { authIssuer } from "@/lib/config-types";
import { useConsoleSession, usePlanIncludes } from "@/lib/console-session";
import { useDeleteApp } from "@/lib/queries";
import { CONVERSATION_RETENTION_DAYS } from "@shared/app-config";

const MEDIA_KINDS = [["images", "Images"], ["audio", "Audio"], ["files", "Other files"]] as const;
const CONVERSATIONS_GUIDE_URL = "https://docs.appaigateway.com/applications/conversations/";
const CONVERSATION_STORAGE_SETUP_URL =
  "https://docs.appaigateway.com/self-hosting/configuration/#conversation-storage";

/**
 * The app as a record: what it is called, its id and the URL clients reach it
 * at, whether it is on, and the way to remove it. Nothing here changes how
 * requests are handled, which is why it sits apart from the sections that do.
 */
export function SettingsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const draft = state.draft!;
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

      <ConversationStorage state={state} readOnly={readOnly} available={capabilities.conversationStorage} />

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

/**
 * Whether the gateway keeps a copy of this app's requests and responses, and
 * for how long. Shown on every deployment, but only switchable on where one
 * has a bucket to keep them in and the plan includes it, so an operator on
 * another learns why it is off. An app that stores conversations under a plan
 * that no longer includes them keeps the setting and stores nothing new, and
 * says so; it can still be switched off.
 */
function ConversationStorage({
  state,
  readOnly,
  available,
}: {
  state: AppDraft;
  readOnly: boolean;
  available: boolean;
}) {
  // Unknown until the billing status loads, which is not the same as left out.
  const excluded = usePlanIncludes("conversationStorage") === false;
  const conversations = state.draft!.config.conversations ?? {};
  const store = conversations.store ?? false;
  const retention = conversations.retention_days ?? CONVERSATION_RETENTION_DAYS.default;
  const keep = {
    images: conversations.keep?.images ?? true,
    audio: conversations.keep?.audio ?? true,
    files: conversations.keep?.files ?? true,
  };
  const [days, setDays] = useState(String(retention));
  const update = (next: { store?: boolean; retention_days?: number; keep?: typeof keep }) =>
    state.updateConfig({ conversations: { store, retention_days: retention, keep, ...next } });

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Conversation history</p>
            <p className="text-xs text-muted-foreground">
              {available && excluded ? (
                <>
                  {store
                    ? "Paused: your plan doesn’t include conversation history, so nothing new is stored. "
                    : "Not included in your plan. "}
                  <Link
                    to="/billing"
                    className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
                  >
                    View plans
                  </Link>
                </>
              ) : available ? (
                <>
                  Keeps a history of each request and response.{" "}
                  <ExternalHint href={CONVERSATIONS_GUIDE_URL}>Learn more</ExternalHint>
                </>
              ) : (
                <>
                  Not set up on this deployment.{" "}
                  <ExternalHint href={CONVERSATION_STORAGE_SETUP_URL}>Set up conversation storage</ExternalHint>
                </>
              )}
            </p>
          </div>
          <Switch
            aria-label="Conversation history"
            checked={store}
            disabled={readOnly || ((!available || excluded) && !store)}
            onCheckedChange={(checked) => update({ store: checked })}
          />
        </div>
        {store ? (
          <Field label="Keep">
            <div className="space-y-2">
              {MEDIA_KINDS.map(([kind, label]) => (
                <div key={kind} className="flex max-w-64 items-center justify-between gap-4">
                  <span className="text-sm">{label}</span>
                  <Switch
                    aria-label={label}
                    checked={keep[kind]}
                    disabled={readOnly}
                    onCheckedChange={(checked) => update({ keep: { ...keep, [kind]: checked } })}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Messages are always kept.</p>
          </Field>
        ) : null}
        {store ? (
          <Field label="Keep for (days)" htmlFor="conversation-retention">
            <Input
              id="conversation-retention"
              type="number"
              inputMode="numeric"
              min={CONVERSATION_RETENTION_DAYS.min}
              max={CONVERSATION_RETENTION_DAYS.max}
              value={days}
              disabled={readOnly}
              className="max-w-32"
              onChange={(event) => {
                setDays(event.target.value);
                const value = Number(event.target.value);
                if (Number.isInteger(value)) update({ retention_days: value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Nightly maintenance deletes stored days older than this.
            </p>
          </Field>
        ) : null}
      </CardContent>
    </Card>
  );
}
