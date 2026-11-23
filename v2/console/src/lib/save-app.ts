import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { diffOperations, type PatchOperation } from "@/lib/json-patch";
import { canonicalJson } from "@contracts/canonical-json";
import { usePatchApp, useUpdateApp } from "@/lib/queries";
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
  // The path ends at the first ": "; a model name in it may hold ":" or spaces.
  const match = /^config\.(.+?): (.+)$/su.exec(error.message);
  return match ? { path: match[1]!, message: match[2]! } : null;
}

/**
 * Saves the app with one part of it changed, at the revision it was read at.
 * Returns the app as the gateway stored it, or null when the save failed.
 */
export function useSaveApp(app: App, { keepsEdits = false }: { keepsEdits?: boolean } = {}) {
  const update = useUpdateApp(app.id);
  const save = async (
    change: { name?: string; status?: App["status"]; config?: AppConfig | unknown },
    done: string,
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
      return null;
    }
  };
  return { save, pending: update.isPending };
}

/**
 * A form over one part of an app, saved as the JSON Patch operations of what
 * the person changed. The draft starts from a deep copy of the stored part
 * and keeps the revision it was read at: an unedited draft follows a newer
 * app, and an edited one is saved at its own revision, so it is never paired
 * with a newer one (the gateway refuses it with `409`, and the form says so).
 *
 * - `path` is the part's JSON Pointer under the app, `read` takes it from an app.
 * - `toDraft` and `toStored` turn the stored part into what the form edits and
 *   back, for a form whose rows are not the stored shape. `toStored` is called
 *   only for a draft the form has found valid.
 * - `edits` says what of a draft counts as an edit: by default all of it. A
 *   form that keeps working state in its draft (an earlier value, a half-typed
 *   number) says here which of it matters, so returning to the stored value is
 *   no edit while an unfinished input still is.
 */
export function usePatchForm<T, D = T>(
  app: App,
  path: string,
  read: (app: App) => T,
  convert: { toDraft: (stored: T) => D; toStored: (draft: D) => T; edits?: (draft: D) => unknown } = {
    toDraft: (stored) => structuredClone(stored) as unknown as D,
    toStored: (draft) => draft as unknown as T,
  },
) {
  const patch = usePatchApp(app.id);
  const edits = convert.edits ?? ((value: D) => value);
  const start = (from: App) => {
    const stored = read(from);
    return { revision: from.revision, stored, initial: canonicalJson(edits(convert.toDraft(stored))) };
  };
  const [base, setBase] = useState(() => start(app));
  const [draft, setDraft] = useState<D>(() => convert.toDraft(base.stored));
  // The gateway's refusal of the last save, until the draft changes or starts again.
  const [refused, setRefused] = useState<{ path: string; message: string } | null>(null);
  const dirty = canonicalJson(edits(draft)) !== base.initial;

  const restart = (from: App) => {
    const next = start(from);
    setBase(next);
    setDraft(convert.toDraft(next.stored));
    setRefused(null);
  };

  // An unedited draft follows a newer version of the app; an edited one keeps its own.
  useEffect(() => {
    if (app.revision !== base.revision && !dirty) restart(app);
    // Only a new revision, or the draft becoming clean, matters here.
  }, [app.revision, base.revision, dirty]);

  /** The operations a valid draft saves as. */
  const operations = (value: D): PatchOperation[] => diffOperations(path, base.stored, convert.toStored(value));

  /** Saves the changed fields; returns the stored app, or null when refused or unchanged. A refusal stays in `refused`. */
  const save = async (done: string): Promise<App | null> => {
    const changes = operations(draft);
    if (changes.length === 0) {
      restart(app);
      return null;
    }
    try {
      const result = await patch.mutateAsync({ revision: base.revision, operations: changes });
      restart(result.app);
      toast.success(done);
      return result.app;
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.code === "app_revision_conflict"
          ? "The app changed since you started editing. Discard your edits to load the latest version."
          : saveError(error, "Could not save the app", true),
      );
      setRefused(configIssue(error));
      return null;
    }
  };

  return {
    draft,
    /** Changes the draft; a refusal of the last save no longer applies to it. */
    setDraft: (next: D) => {
      setDraft(next);
      setRefused(null);
    },
    /** The part as stored when this draft started. */
    stored: base.stored,
    /** Where the gateway refused the last save, as `config.<path>: <message>` said it, or null. */
    refused,
    dirty,
    /** The app changed since this edited draft was read: saving it would be refused. */
    stale: dirty && app.revision !== base.revision,
    /** Throws the edits away and starts again from the app as it is now. */
    discard: () => restart(app),
    save,
    pending: patch.isPending,
  };
}
