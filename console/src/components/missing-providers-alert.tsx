import { Fragment } from "react";
import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ProviderName } from "@/components/brand-icon";
import {
  enabledProviders,
  type ProxyConfig,
  type Provider,
} from "@/lib/config-types";
import { useProviders } from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";

/** Enabled provider types the organization has no active credential for. */
export function unconfiguredProviders(
  proxy: ProxyConfig,
  credentials: ProviderCredential[],
): Provider[] {
  const active = credentials.filter((row) => row.status === "active");
  const configured = new Set(active.map((row) => row.type));
  // `selected` names instance slugs, so the app's providers are only knowable
  // through the organization's rows — the same rows that answer "configured?".
  return enabledProviders(proxy, active).filter((provider) => !configured.has(provider));
}

/**
 * Non-blocking: the app is configured correctly, the organization simply has no
 * key for one of the providers it allows, so those requests will answer
 * `provider_not_configured` until someone adds one.
 */
export function MissingProvidersAlert({ proxy }: { proxy: ProxyConfig }) {
  const providers = useProviders();
  // Say nothing until the list is known, rather than flashing a false warning.
  if (!providers.data) return null;

  const missing = unconfiguredProviders(proxy, providers.data.providers);
  if (missing.length === 0) return null;

  return (
    <Alert>
      <AlertCircle />
      {/* The marks sit inside the sentence rather than beside it: the alert
          names providers, and the reader is looking for one of them. Inline,
          not a flex row — the title clamps itself to one line. */}
      <AlertTitle>
        No credential for{" "}
        {missing.map((provider, index) => (
          <Fragment key={provider}>
            {index > 0 ? ", " : null}
            <ProviderName type={provider} className="align-middle" />
          </Fragment>
        ))}
      </AlertTitle>
      <AlertDescription>
        This app allows{" "}
        {missing.length === 1 ? "a provider" : "providers"} your organization has not configured, so
        those requests fail with <code className="font-mono text-xs">provider_not_configured</code>.{" "}
        <Link to="/providers" className="underline underline-offset-4">
          Add a provider key
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
