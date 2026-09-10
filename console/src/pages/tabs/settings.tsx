import { useState } from "react";
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
import { useConsoleSession } from "@/lib/console-session";
import { useDeleteApp } from "@/lib/queries";

/**
 * The app as a record: what it is called, whether it is on, and the way to
 * remove it. Nothing here changes how requests are handled, which is why it
 * sits apart from the sections that do.
 */
export function SettingsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const draft = state.draft!;
  const navigate = useNavigate();
  const deleteApp = useDeleteApp();
  const { readOnly } = useConsoleSession();
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
          <Field
            label="Application id"
            htmlFor="app-id"
            hint="Fixed when the app was created. It is part of every URL your clients call."
          >
            <div className="flex max-w-md gap-2">
              <Input id="app-id" value={appId} readOnly className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                className="min-w-24"
                onClick={() => void copyId()}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
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
