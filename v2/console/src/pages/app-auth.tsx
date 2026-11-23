import { Link } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AppAttestFields,
  IdentityProviderFields,
  SubscriptionFields,
  UserSourceFields,
  shownField,
  signInConfig,
  signInDraftOf,
  signInEdits,
  signInIssues,
  type SignInDraft,
} from "@/components/auth-fields";
import { GuardedButton } from "@/components/guarded-button";
import { StaleDraftNotice } from "@/components/stale-draft-notice";
import { useConsoleSession } from "@/lib/console-session";
import { usePatchForm } from "@/lib/save-app";
import { LeaveGuard } from "@/components/leave-guard";
import type { App } from "@/lib/types";
import type { AuthenticationConfig } from "@contracts/app-config";

const readAuthentication = (app: App) => app.config.authentication as AuthenticationConfig;


/**
 * Who may call this app, as v1's auth policy asked it: how the app proves
 * itself, whether its users must be signed in and where, and whether they
 * must have paid. Saved as the fields the person changed, nothing else.
 */
export function SignInTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const form = usePatchForm<AuthenticationConfig, SignInDraft>(app, "/config/authentication", readAuthentication, {
    toDraft: (stored) => signInDraftOf(stored),
    toStored: signInConfig,
    edits: signInEdits,
  });
  const draft = form.draft;
  const issues = signInIssues(draft);
  // A refusal from the gateway is shown where it applies, until the form changes.
  const refused = form.refused;
  const refusedAt = refused?.path.startsWith("authentication.") ? refused.path.slice("authentication.".length) : null;
  // Only a refusal about a field these cards show is said beside it; any other is said above the save button.
  const refusedHere = refusedAt !== null && shownField(refusedAt) ? refusedAt : null;
  if (refused && refusedHere !== null && !issues.has(refusedHere)) issues.set(refusedHere, refused.message);
  const disabled = readOnly || form.pending;

  return (
    <div className="space-y-4">
      <LeaveGuard dirty={form.dirty} />
      {form.stale ? <StaleDraftNotice onDiscard={form.discard} /> : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How the app proves itself</CardTitle>
          <CardDescription>
            {draft.appAttest !== null
              ? "An iOS app. Only builds signed with this team and bundle id can call through the gateway."
              : "A server app. Your server proves itself with an app key."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {draft.appAttest !== null ? (
            <AppAttestFields value={draft.appAttest} issues={issues} disabled={disabled} onChange={(appAttest) => form.setDraft({ ...draft, appAttest })} />
          ) : (
            <p className="text-sm">
              Create and revoke its keys on the{" "}
              <Link className="underline" to={`/apps/${encodeURIComponent(app.id)}/keys`}>
                Keys
              </Link>{" "}
              tab.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Who may call</CardTitle>
          <CardDescription>Whether calls must come from users signed in to your app.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UserSourceFields draft={draft} issues={issues} disabled={disabled} onChange={form.setDraft} />
        </CardContent>
      </Card>

      {draft.source === "issuer" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Identity provider</CardTitle>
              <CardDescription>Where your users sign in. The gateway checks their sign-in tokens against it.</CardDescription>
            </CardHeader>
            <CardContent>
              <IdentityProviderFields form={draft.issuer} issues={issues} disabled={disabled} onChange={(issuer) => form.setDraft({ ...draft, issuer })} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Paid users only</CardTitle>
              <CardDescription>Whether a user must have paid before they can call.</CardDescription>
            </CardHeader>
            <CardContent>
              <SubscriptionFields form={draft.issuer} issues={issues} disabled={disabled} onChange={(issuer) => form.setDraft({ ...draft, issuer })} />
            </CardContent>
          </Card>
        </>
      ) : null}

      {refused && refusedHere === null ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>{refused.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-2">
        <GuardedButton disabled={!form.dirty || form.stale || issues.size > 0 || form.pending} onClick={() => void form.save("Sign-in saved")}>
          {form.pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save sign-in
        </GuardedButton>
        <Button type="button" variant="outline" disabled={!form.dirty || form.pending} onClick={form.discard}>
          Discard changes
        </Button>
      </div>
    </div>
  );
}
