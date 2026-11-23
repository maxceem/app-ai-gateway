import { useState } from "react";
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
  authIssues,
  type AuthDraft,
} from "@/components/auth-fields";
import { GuardedButton } from "@/components/guarded-button";
import { StaleDraftNotice } from "@/components/stale-draft-notice";
import { useConsoleSession } from "@/lib/console-session";
import { configIssue, usePatchForm } from "@/lib/save-app";
import type { App } from "@/lib/types";

const readAuthentication = (app: App) => app.config.authentication as AuthDraft;

/**
 * Who may call this app, as v1's auth policy asked it: how the app proves
 * itself, whether its users must be signed in and where, and whether they
 * must have paid. Saved as the fields the person changed, nothing else.
 */
export function SignInTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const form = usePatchForm(app, "/config/authentication", readAuthentication);
  const draft = form.draft;
  const [refused, setRefused] = useState<{ path: string; message: string } | null>(null);

  const change = (next: AuthDraft) => {
    form.setDraft(next);
    setRefused(null);
  };
  const issues = authIssues(draft);
  // A refusal from the gateway is shown where it applies, until the form changes.
  const refusedHere = refused?.path.startsWith("authentication.") ? refused.path.slice("authentication.".length) : null;
  if (refused && refusedHere !== null && !issues.has(refusedHere)) issues.set(refusedHere, refused.message);
  const disabled = readOnly || form.pending;
  const endUser = draft.end_user;

  const submit = async () => {
    await form.save("Sign-in saved", (error) => setRefused(configIssue(error)));
  };

  return (
    <div className="space-y-4">
      {form.stale ? <StaleDraftNotice onDiscard={form.discard} /> : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How the app proves itself</CardTitle>
          <CardDescription>
            {draft.type === "apple_app_attest"
              ? "An iOS app. Only builds signed with this team and bundle id can call through the gateway."
              : "A server app. Your server proves itself with an app key."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {draft.type === "apple_app_attest" ? (
            <AppAttestFields value={draft.app_attest} issues={issues} disabled={disabled} onChange={(app_attest) => change({ ...draft, app_attest })} />
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
          <UserSourceFields
            type={draft.type}
            value={endUser}
            issues={issues}
            disabled={disabled}
            onChange={(end_user) => change({ ...draft, end_user } as AuthDraft)}
          />
          {refusedHere === "end_user" ? (
            <p role="alert" className="text-xs text-destructive">
              {refused?.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {endUser.source === "issuer" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Identity provider</CardTitle>
              <CardDescription>Where your users sign in. The gateway checks their sign-in tokens against it.</CardDescription>
            </CardHeader>
            <CardContent>
              <IdentityProviderFields
                issuer={endUser.issuer}
                issues={issues}
                disabled={disabled}
                onChange={(issuer) => change({ ...draft, end_user: { ...endUser, issuer } } as AuthDraft)}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Paid users only</CardTitle>
              <CardDescription>Whether a user must have paid before they can call.</CardDescription>
            </CardHeader>
            <CardContent>
              <SubscriptionFields
                issuer={endUser.issuer}
                issues={issues}
                disabled={disabled}
                onChange={(issuer) => change({ ...draft, end_user: { ...endUser, issuer } } as AuthDraft)}
              />
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
        <GuardedButton disabled={!form.dirty || form.stale || issues.size > 0 || form.pending} onClick={() => void submit()}>
          {form.pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save sign-in
        </GuardedButton>
        <Button
          type="button"
          variant="outline"
          disabled={!form.dirty || form.pending}
          onClick={() => {
            form.discard();
            setRefused(null);
          }}
        >
          Discard changes
        </Button>
      </div>
    </div>
  );
}
