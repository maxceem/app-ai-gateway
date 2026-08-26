import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DisabledReason } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { Card, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "@/components/field";
import { IssuerCards } from "@/components/issuer-form";
import type { AppDraft } from "@/hooks/use-app-draft";
import { authIssuer } from "@/lib/config-types";
import { ServerKeys } from "@/pages/server-keys";

const ISSUER_TOGGLE_LABEL = "Require verified user identity (issuer JWT)";

const ISSUER_HELP =
  "With an issuer configured, clients exchange their API key plus an issuer JWT for a short-lived gateway token, and per-user identity and entitlements are enforced on every request. Without one, the API key is used directly and user ids are self-reported.";

export function AuthPolicyTab({ appId, state }: { appId: string; state: AppDraft }) {
  const authentication = state.draft!.config.authentication;
  const { readOnly } = useConsoleSession();
  const issuer = authIssuer(authentication);

  if (authentication.type === "api_key") {
    return (
      <div className="space-y-4">
        <Alert>
          <KeyRound />
          <AlertTitle>Server tenant authentication</AlertTitle>
          <AlertDescription>
            {issuer
              ? "This app exchanges an API key plus an issuer token for a short-lived gateway token. Bare API keys are rejected on proxy requests."
              : "This app accepts long-lived server API keys directly. App Attest registration is disabled."}
          </AlertDescription>
        </Alert>
        <ServerKeys appId={appId} />

        <Card>
          <CardHeader>
            <SectionHeader
              title="Verified user identity"
              description={ISSUER_HELP}
              action={
                readOnly ? (
                  <DisabledReason reason={READ_ONLY_REASON}>
                    <Switch checked={issuer !== undefined} disabled aria-label={ISSUER_TOGGLE_LABEL} />
                  </DisabledReason>
                ) : (
                  <Switch
                    checked={issuer !== undefined}
                    aria-label={ISSUER_TOGGLE_LABEL}
                    onCheckedChange={(checked) => state.setIssuerEnabled(checked)}
                  />
                )
              }
            />
          </CardHeader>
        </Card>

        {issuer ? <IssuerCards issuer={issuer} onChange={state.updateIssuer} /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <IssuerCards issuer={authentication.issuer} onChange={state.updateIssuer} />
    </div>
  );
}
