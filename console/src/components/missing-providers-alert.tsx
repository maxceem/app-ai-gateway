import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  enabledProviders,
  PROVIDER_LABELS,
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
  const configured = new Set(
    credentials.filter((row) => row.status === "active").map((row) => row.type),
  );
  return enabledProviders(proxy).filter((provider) => !configured.has(provider));
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
      <AlertTitle>
        No credential for {missing.map((provider) => PROVIDER_LABELS[provider]).join(", ")}
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
