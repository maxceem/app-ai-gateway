import { useId } from "react";
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
import { authIssuer, emptyIssuer } from "@/lib/config-types";
import { ServerKeys } from "@/pages/server-keys";

const ISSUER_TOGGLE_LABEL = "Require verified user identity (issuer JWT)";

const ISSUER_HELP =
  "With an issuer configured, clients exchange their API key plus an issuer JWT for a short-lived gateway token. The claims below are checked at every exchange, and the token carries a verified user id that per-user blocks and usage reporting apply to. Without one, the API key is used directly and user ids are self-reported.";

export function AuthPolicyTab({ appId, state }: { appId: string; state: AppDraft }) {
  const authentication = state.draft!.config.authentication;
  const { readOnly } = useConsoleSession();
  const readOnlyReasonId = useId();
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
        <ServerKeys appId={appId} exchanged={issuer !== undefined} />

        <Card>
          <CardHeader>
            <SectionHeader
              title="Verified user identity"
              description={ISSUER_HELP}
              action={
                readOnly ? (
                  // Same treatment as GuardedButton: the switch keeps its own
                  // name and points at the reason it cannot be operated.
                  <DisabledReason reason={READ_ONLY_REASON} reasonId={readOnlyReasonId}>
                    <Switch
                      checked={issuer !== undefined}
                      disabled
                      aria-disabled="true"
                      aria-describedby={readOnlyReasonId}
                      aria-label={ISSUER_TOGGLE_LABEL}
                    />
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

  // App Attest apps always carry an issuer; a config edited without one still
  // opens on the defaults rather than crashing the tab.
  return (
    <div className="space-y-4">
      <IssuerCards issuer={authentication.issuer ?? emptyIssuer()} onChange={state.updateIssuer} />
    </div>
  );
}
