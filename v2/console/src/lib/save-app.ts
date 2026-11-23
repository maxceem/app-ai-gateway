import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useUpdateApp } from "@/lib/queries";
import type { App, AppConfig } from "@/lib/types";

/**
 * What a save refusal means for the person, in words. Settings keeps what
 * was typed through a conflict; the shorter forms reload and ask again.
 */
export function saveError(error: unknown, fallback: string, keepsEdits: boolean): string {
  if (error instanceof ApiError && error.code === "app_revision_conflict") {
    return keepsEdits
      ? "The app changed since you opened it. Your edits are kept; save again to replace it."
      : "The app changed since you opened it. The latest version is loaded; make your change again.";
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * A refused save's message, split into the configuration path it is about and
 * the words. The gateway says `config.<path>: <message>`.
 */
export function configIssue(error: unknown): { path: string; message: string } | null {
  if (!(error instanceof ApiError) || error.code === "app_revision_conflict") return null;
  const match = /^config\.([^:\s]+): (.+)$/su.exec(error.message);
  return match ? { path: match[1]!, message: match[2]! } : null;
}

/**
 * Saves the app with one part of it changed, at the revision it was read at.
 * Returns the app as the gateway stored it, or null when the save failed.
 * `onRefused` hears the refusal too, so a form can show it beside the field.
 */
export function useSaveApp(app: App, { keepsEdits = false }: { keepsEdits?: boolean } = {}) {
  const update = useUpdateApp(app.id);
  const save = async (
    change: { name?: string; status?: App["status"]; config?: AppConfig | unknown },
    done: string,
    onRefused?: (error: unknown) => void,
  ) => {
    try {
      const result = await update.mutateAsync({
        name: change.name ?? app.name,
        status: change.status ?? app.status,
        // An explicit config is sent as typed, even `null`: the gateway refuses
        // what is not valid, rather than this page saving the old one instead.
        config: "config" in change ? change.config : app.config,
        revision: app.revision,
      });
      toast.success(done);
      return result.app;
    } catch (error) {
      toast.error(saveError(error, "Could not save the app", keepsEdits));
      onRefused?.(error);
      return null;
    }
  };
  return { save, pending: update.isPending };
}
