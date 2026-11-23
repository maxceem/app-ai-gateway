import { Link } from "react-router-dom";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { retiringModels } from "@/lib/app-notices";
import { providerLabel } from "@/lib/providers";
import { useAppKeys, usePrices, useProviders } from "@/lib/queries";
import type { App } from "@/lib/types";

/**
 * What the app page says above whichever tab is open: the gateway's own
 * warnings about the app, models it names that are leaving our price list,
 * and a key-protected app with no active key. Each is silent when there is
 * nothing to say, or while what it needs has not loaded.
 */
export function AppNotices({ app }: { app: App }) {
  return (
    <>
      <AppWarningsAlert app={app} />
      <RetiringModelsNotice app={app} />
      {app.config.authentication.type === "api_key" ? <NoKeysNotice app={app} /> : null}
    </>
  );
}

/** The gateway's warnings about the app: behaviour that stops on a stated date. */
function AppWarningsAlert({ app }: { app: App }) {
  const warnings = app.warnings ?? [];
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
              {warning.until ? <span className="text-muted-foreground"> Until {warning.until}.</span> : null}
              {warning.docs_url ? (
                <>
                  {" "}
                  <a href={warning.docs_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
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

/** Models the app names that our price list says are retiring or no longer listed. */
function RetiringModelsNotice({ app }: { app: App }) {
  const providers = useProviders();
  const prices = usePrices();
  // Only once both are read; a notice never stands in the way of the page.
  const list = providers.data?.providers;
  const table = prices.data?.prices;
  if (!Array.isArray(list) || typeof table !== "object" || table === null) return null;
  const retiring = retiringModels(app, list, table);
  if (retiring.length === 0) return null;
  return (
    <Alert role="status" className="border-amber-500/60">
      <TriangleAlert />
      <AlertTitle>{retiring.length === 1 ? "A model this app uses is leaving" : "Models this app uses are leaving"}</AlertTitle>
      <AlertDescription>
        <ul className="space-y-1">
          {retiring.map((entry) => (
            <li key={`${entry.type}:${entry.model}`}>
              <span className="font-mono">{entry.model}</span> on {providerLabel(entry.type)}{" "}
              {entry.retirementDate ? `retires on ${entry.retirementDate}` : `is no longer on our price list since ${entry.unlistedSince}`}.{" "}
              <span className="text-muted-foreground">Used in {entry.where.join(", ")}.</span>
            </li>
          ))}
        </ul>
        <p>Calls to it keep working until then. Move the app to another model before that date.</p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The one state that stops a key-protected app's traffic with no other sign
 * of it: no key was ever created, or every key was revoked.
 */
function NoKeysNotice({ app }: { app: App }) {
  const keys = useAppKeys(app.id);
  const list = keys.data?.keys;
  if (!Array.isArray(list) || list.some((key) => key.status === "active")) return null;
  return (
    <Alert role="status">
      <KeyRound />
      <AlertTitle>This app has no active API key</AlertTitle>
      <AlertDescription>
        Nothing can call it until one is created.{" "}
        <Link to={`/apps/${encodeURIComponent(app.id)}/keys`} className="underline underline-offset-4">
          Create an API key
        </Link>
      </AlertDescription>
    </Alert>
  );
}
