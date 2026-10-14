import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatDateTime } from "@/lib/format";
import type { AppWarning } from "@contracts/responses";

/**
 * What about this app stops working on a stated date, as the gateway computed
 * it when the app was read. Nothing here can be edited: each warning says what
 * to change in the app itself, and by when.
 */
export function AppWarningsAlert({ warnings }: { warnings: readonly AppWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert role="status" className="border-amber-500/60">
      <TriangleAlert />
      <AlertTitle>{warnings.length === 1 ? "This app has a warning" : "This app has warnings"}</AlertTitle>
      <AlertDescription>
        <ul className="space-y-1">
          {warnings.map((warning) => (
            <li key={warning.code}>
              {warning.message}
              {warning.until ? (
                <span className="text-muted-foreground"> Until {formatDateTime(warning.until)}.</span>
              ) : null}
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
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
