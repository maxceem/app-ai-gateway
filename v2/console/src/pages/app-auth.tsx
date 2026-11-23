import { useEffect, useState } from "react";
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
import { useConsoleSession } from "@/lib/console-session";
import { requiresPayment } from "@/lib/issuer-presets";
import { AuthenticationConfigSchema } from "@contracts/app-config";
import type { App } from "@/lib/types";
import { configIssue, useSaveApp } from "@/lib/save-app";

/** The stored block, as the form edits it. */
function draftOf(app: App): AuthDraft {
  return structuredClone(app.config.authentication) as AuthDraft;
}

/** Problems the schema cannot see: a paid check that names no claim would let every user in. */
function formProblems(draft: AuthDraft): string | undefined {
  const endUser = draft.end_user;
  if (endUser.source === "issuer" && requiresPayment(endUser.issuer) && endUser.issuer.required_claims.length === 0) {
    return "Add at least one claim, or choose Any signed-in user.";
  }
  return undefined;
}

/**
 * Who may call this app, as v1's auth policy asked it: how the app proves
 * itself, whether its users must be signed in and where, and whether they
 * must have paid. One form and one save; the rest of the configuration is
 * sent back as it was read.
 */
export function SignInTab({ app }: { app: App }) {
  const { readOnly } = useConsoleSession();
  const { save, pending } = useSaveApp(app);
  const [draft, setDraft] = useState(() => draftOf(app));
  const [refused, setRefused] = useState<{ path: string; message: string } | null>(null);
  // Follows the saved block after every save, here or elsewhere.
  useEffect(() => {
    setDraft(draftOf(app));
    setRefused(null);
  }, [app.revision]);

  const change = (next: AuthDraft) => {
    setDraft(next);
    setRefused(null);
  };
  const issues = authIssues(draft);
  // A refusal from the gateway is shown where it applies, until the form changes.
  const refusedHere = refused?.path.startsWith("authentication.") ? refused.path.slice("authentication.".length) : null;
  if (refused && refusedHere !== null && !issues.has(refusedHere)) issues.set(refusedHere, refused.message);
  const extra = formProblems(draft);
  // Compared as the gateway would store it, so defaults filled in on save do not count as a change.
  const normalized = AuthenticationConfigSchema.safeParse(draft);
  const dirty = !normalized.success || JSON.stringify(normalized.data) !== JSON.stringify(app.config.authentication);
  const disabled = readOnly || pending;
  const endUser = draft.end_user;

  const submit = async () => {
    const saved = await save({ config: { ...app.config, authentication: draft } }, "Sign-in saved", (error) => setRefused(configIssue(error)));
    if (saved) setDraft(draftOf(saved));
  };

  return (
    <div className="space-y-4">
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
          {refusedHere === "end_user" ? <p role="alert" className="text-xs text-destructive">{refused?.message}</p> : null}
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
                onChange={(issuer) => change({ ...draft, end_user: { source: "issuer", issuer } } as AuthDraft)}
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
                onChange={(issuer) => change({ ...draft, end_user: { source: "issuer", issuer } } as AuthDraft)}
              />
              {extra ? <p role="alert" className="mt-2 text-xs text-destructive">{extra}</p> : null}
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
        <GuardedButton disabled={!dirty || issues.size > 0 || extra !== undefined || pending} onClick={() => void submit()}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Save sign-in
        </GuardedButton>
        <Button type="button" variant="outline" disabled={!dirty || pending} onClick={() => change(draftOf(app))}>
          Discard changes
        </Button>
      </div>
    </div>
  );
}
