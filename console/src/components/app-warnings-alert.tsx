import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { GuardedButton } from "@/components/guarded-button";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useDisableLegacyMode } from "@/lib/queries";
import type { AppWarning } from "@contracts/responses";

/**
 * What about this app stops working on a stated date, as the gateway computed
 * it when the app was read. A legacy mode can be ended early from here, and
 * only ended: nothing in the console creates or extends one.
 */
export function AppWarningsAlert({ appId, warnings }: { appId: string; warnings: readonly AppWarning[] }) {
  const [confirming, setConfirming] = useState(false);
  const disable = useDisableLegacyMode(appId);
  if (warnings.length === 0) return null;

  const onConfirm = async () => {
    try {
      await disable.mutateAsync("unsigned_requests");
      toast.success("Legacy mode disabled", {
        description: "Requests without an App Attest proof are refused from now on.",
      });
      setConfirming(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disable legacy mode");
    }
  };

  return (
    <Alert role="status" className="border-amber-500/60">
      <TriangleAlert />
      <AlertTitle>{warnings.length === 1 ? "This app has a warning" : "This app has warnings"}</AlertTitle>
      <AlertDescription>
        <ul className="space-y-2">
          {warnings.map((warning) => (
            <li key={warning.code}>
              {warning.legacy === "unsigned_requests" ? (
                <>
                  <p>
                    Legacy mode: unsigned requests accepted until {formatDateTime(warning.until)}. Last unsigned
                    request {warning.unsigned_last_seen_at ? formatRelative(warning.unsigned_last_seen_at) : "none seen yet"}.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <GuardedButton size="sm" variant="outline" onClick={() => setConfirming(true)}>
                      Disable legacy mode
                    </GuardedButton>
                    {warning.docs_url ? (
                      <a
                        href={warning.docs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary-ink underline underline-offset-4"
                      >
                        What to change
                      </a>
                    ) : null}
                  </div>
                </>
              ) : (
                <>
                  {warning.message}
                  {warning.docs_url ? (
                    <>
                      {" "}
                      <a
                        href={warning.docs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary-ink underline underline-offset-4"
                      >
                        What to change
                      </a>
                    </>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title="Disable legacy mode?"
        description={
          <p>
            Requests without an App Attest proof will be refused immediately. Do this only when every build in use
            is on AppAIGateway package 2.x.
          </p>
        }
        confirmLabel="Disable legacy mode"
        destructive
        pending={disable.isPending}
        onConfirm={() => void onConfirm()}
      />
    </Alert>
  );
}
