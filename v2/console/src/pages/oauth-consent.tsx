import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { call } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { loginUrlFor, signupUrlFor } from "@/lib/auth-redirect";
import { useCapabilities, useSignOut } from "@/lib/queries";
import type { ConsentDetails } from "@/lib/types";
import { clearStoredProof, readStoredProof, writeStoredProof } from "@/lib/stored-proof";

/**
 * Where an OAuth client's authorization request sends a person (an MCP client,
 * or the CLI on a machine with a browser): the client says who it is and what
 * it wants, and the person allows it into one of their accounts, or denies it.
 *
 * Outside the authenticated shell, because one of its states is that nobody
 * may be signed in yet:
 *
 * - signed in: the client, the grant it asked for, which account it gets and
 *   with how much of the person's role, then Allow or Deny;
 * - nobody signed in: sign in, create an account, or Google where the
 *   deployment has it, each of which brings the browser back here;
 * - refused: a person signed in who belongs to no account the client could use.
 *
 * What it offers is the gateway's verdict (`blockedBy`), so the button shown
 * and the answer pressing it gets agree. Every answer is a redirect back to
 * the client, which the page follows.
 *
 * The client's name is its own claim, and arbitrary text: it is rendered as
 * text, always beside the domain that served it, and never as anything else.
 *
 * The proof arrives in the URL fragment, which never leaves the browser. It
 * is stripped from the address bar on arrival and kept in `sessionStorage`
 * under this authorization's own path, so sign-in and Google bring the page
 * back to life.
 *
 * It must never be framed, or a page could trick a signed-in person into
 * pressing Allow. That is the console-wide `frame-ancestors 'none'` rule in
 * `v2/console/public/_headers`, not a rule of this page's own: it is often
 * reached by client-side navigation after signing in, which loads no document
 * a path-specific rule could match.
 */

/** The path this authorization's page lives at, without its proof: where sign-in returns to. */
function consentPath(id: string): string {
  return `/oauth/consent?id=${encodeURIComponent(id)}`;
}

function storageKeyFor(id: string): string {
  return `app-ai-gateway:oauth-consent:${consentPath(id)}`;
}

type Grant = ConsentDetails["requestedGrant"];

const GRANTS: Choice<Grant>[] = [
  {
    value: "manage",
    label: "Manage",
    description: "Everything your role allows: create, change and delete apps, providers and keys.",
  },
  {
    value: "read",
    label: "Read only",
    description: "Lists and inspects apps, providers and usage, but cannot change them.",
  },
];

const ROLE_NAMES = { owner: "Owner", admin: "Admin", member: "Member" } as const;

export function OAuthConsentPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const id = new URLSearchParams(location.search).get("id") ?? "";
  const storageKey = storageKeyFor(id);

  /* Resolved once, before the effect below rewrites the address bar. */
  const [token] = useState(() => location.hash.replace(/^#/, "") || readStoredProof(storageKey)?.token || "");

  useEffect(() => {
    if (!location.hash) return;
    void navigate(`${location.pathname}${location.search}`, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  const details = useQuery({
    queryKey: ["oauth-consent", id],
    queryFn: () => call("getOauthConsent", { params: { id }, body: { proof: token } }),
    enabled: Boolean(id && token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const data = details.data;
  useEffect(() => {
    if (!data) return;
    writeStoredProof(storageKey, { token, expiresAt: Date.parse(data.expiresAt) });
  }, [data, storageKey, token]);

  /* Where the browser is being sent: the client's redirect URI, with its code or the denial. */
  const [leaving, setLeaving] = useState<{ redirect: string; denied: boolean } | null>(null);
  const leave = (redirect: string, denied: boolean) => {
    clearStoredProof(storageKey);
    setLeaving({ redirect, denied });
    window.location.assign(redirect);
  };

  const allow = useMutation({
    mutationFn: (body: { accountId: string; grant: Grant }) =>
      call("allowOauthConsent", { params: { id }, body: { proof: token, ...body } }),
    onSuccess: (result) => leave(result.redirect, false),
  });
  const deny = useMutation({
    mutationFn: () => call("denyOauthConsent", { params: { id }, body: { proof: token } }),
    onSuccess: (result) => leave(result.redirect, true),
  });

  if (!id || !token) {
    return (
      <ConsentShell id={id}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This link is missing its proof</AlertTitle>
          <AlertDescription>
            Open the full link your app sent you to, or start the connection again from your app.
          </AlertDescription>
        </Alert>
      </ConsentShell>
    );
  }

  if (details.isPending) {
    return (
      <ConsentShell id={id}>
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ConsentShell>
    );
  }

  if (details.isError || !data) {
    return (
      <ConsentShell id={id}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This connection can no longer be approved</AlertTitle>
          <AlertDescription>
            {authErrorMessage(details.error, "The link has expired or was already used.")} Start the
            connection again from your app.
          </AlertDescription>
        </Alert>
      </ConsentShell>
    );
  }

  if (leaving) {
    return (
      <ConsentShell id={id} expiresAt={data.expiresAt}>
        <Alert role="status">
          {leaving.denied ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
          <AlertTitle>{leaving.denied ? "Connection declined" : "Connection approved"}</AlertTitle>
          <AlertDescription>Returning you to {data.redirectHost}…</AlertDescription>
        </Alert>
        {/* The navigation normally leaves this page at once; the link is for a browser that held it back. */}
        <Button asChild variant="outline" className="w-full">
          <a href={leaving.redirect}>
            Continue to {data.redirectHost}
            <ArrowRight className="size-4" />
          </a>
        </Button>
      </ConsentShell>
    );
  }

  const error = allow.isError
    ? authErrorMessage(allow.error, "The connection could not be approved")
    : deny.isError
      ? authErrorMessage(deny.error, "Could not decline the connection")
      : null;
  const busy = allow.isPending || deny.isPending;

  return (
    <ConsentShell id={id} expiresAt={data.expiresAt}>
      <ClientSummary details={data} />

      {data.state !== "pending" ? (
        <Settled state={data.state} />
      ) : data.blockedBy === "sign_in_required" ? (
        <SignedOut id={id} />
      ) : data.blockedBy === "no_account" ? (
        <NoEligibleAccount viewer={data.viewer} onDone={() => void details.refetch()} />
      ) : (
        <AllowForm
          details={data}
          busy={busy}
          allowing={allow.isPending}
          onAllow={(body) => allow.mutate(body)}
          onSignedOut={() => void details.refetch()}
        />
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {data.state === "pending" ? (
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <p className="text-sm text-muted-foreground">Did not start this?</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => deny.mutate()}>
            {deny.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Deny
          </Button>
        </div>
      ) : null}
    </ConsentShell>
  );
}

function ConsentShell({ id, expiresAt, children }: { id: string; expiresAt?: string; children: React.ReactNode }) {
  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-3">
        <Card className="w-full">
          <CardHeader className="grid-rows-[auto] gap-0">
            <CardTitle>Connect an app to your account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
        <div className="space-y-0.5 px-1 text-xs text-muted-foreground">
          {id ? <p className="font-mono break-all">{id}</p> : null}
          {expiresAt ? <p>Expires {new Date(expiresAt).toLocaleString()}.</p> : null}
        </div>
      </div>
    </AuthLayout>
  );
}

/** A labelled read-only box, as the CLI's approval page draws one. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

/**
 * Who is asking, as the gateway could verify it. The name is the client's own
 * claim, so it is always paired with what vouches for it: the domain that
 * served its metadata document, or the deployment's own registration.
 */
function ClientSummary({ details }: { details: ConsentDetails }) {
  const asked = GRANTS.find((grant) => grant.value === details.requestedGrant)!;
  return (
    <div className="space-y-3">
      <Field label="App">
        <p className="text-sm font-medium break-words">{details.client.name}</p>
        <p className="text-xs text-muted-foreground break-all">
          {details.client.domain
            ? `as declared by ${details.client.domain}`
            : "registered by this gateway"}
        </p>
      </Field>
      <Field label="Asks for">
        <p className="text-sm font-medium">{asked.label}</p>
        <p className="text-xs text-muted-foreground">{asked.description}</p>
      </Field>
      <p className="text-xs text-muted-foreground">
        Once you decide, this browser returns to <span className="font-medium">{details.redirectHost}</span>.
      </p>
    </div>
  );
}

/** An authorization already decided, or past its ten minutes: nothing to offer but the way back. */
function Settled({ state }: { state: ConsentDetails["state"] }) {
  const [title, text] = state === "completed"
    ? ["Already approved", "This connection was approved already. You can close this tab."]
    : state === "denied"
      ? ["Declined", "This connection was declined. Start it again from your app if that was a mistake."]
      : ["This request has expired", "Start the connection again from your app."];
  return (
    <Alert role="status">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/**
 * Nobody is signed in. Signing in, creating an account and Google each leave
 * this page and come back to it.
 */
function SignedOut({ id }: { id: string }) {
  const capabilities = useCapabilities();
  const back = consentPath(id);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Sign in to choose which of your accounts this app may use.</p>
      {capabilities.data?.googleAuth ? <GoogleButton returnPath={back} /> : null}
      <div className="grid gap-2">
        <Button asChild className="w-full">
          <Link to={loginUrlFor(back)}>Sign in</Link>
        </Button>
        {capabilities.data?.registrationOpen ? (
          <Button asChild variant="outline" className="w-full">
            <Link to={signupUrlFor(back)}>Create an account</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A signed-in person with no account this app could use. Nothing here can fix
 * that, so the page says who is signed in and offers signing in as somebody
 * else, on this same page.
 */
function NoEligibleAccount({
  viewer,
  onDone,
}: {
  viewer: ConsentDetails["viewer"];
  onDone: () => void;
}) {
  const signOut = useSignOut();
  const who = viewer?.name ?? viewer?.email;
  return (
    <Alert role="alert">
      <AlertTitle>No account to connect</AlertTitle>
      <AlertDescription className="space-y-3">
        <span>
          {who ? `${who} is` : "You are"} not a member of any account this app can use. Ask an owner to add
          you, then reload this page.
        </span>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate(undefined, { onSettled: onDone })}
        >
          {signOut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Sign in as someone else
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Which account the app gets, with how much of the person's role, and Allow.
 * One account needs no question and is named; several are offered with none
 * chosen, because a default would choose for a person who did not look. The
 * grant starts at what the app asked for.
 */
function AllowForm({
  details,
  busy,
  allowing,
  onAllow,
  onSignedOut,
}: {
  details: ConsentDetails;
  busy: boolean;
  allowing: boolean;
  onAllow: (body: { accountId: string; grant: Grant }) => void;
  onSignedOut: () => void;
}) {
  const signOut = useSignOut();
  const [chosen, setChosen] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant>(details.requestedGrant);
  const accounts = details.accounts;
  const only = accounts.length === 1 ? accounts[0]! : null;
  const selected = only ? only.id : accounts.some((account) => account.id === chosen) ? chosen : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected) onAllow({ accountId: selected, grant });
  };

  const who = details.viewer?.name ?? details.viewer?.email ?? "Signed-in user";
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Signed in as">
        <p className="text-sm font-medium">{who}</p>
        {details.viewer?.email && details.viewer.name ? (
          <p className="text-xs text-muted-foreground">{details.viewer.email}</p>
        ) : null}
        <button
          type="button"
          className="mt-1 text-xs text-primary-ink underline underline-offset-4"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate(undefined, { onSettled: onSignedOut })}
        >
          Use another sign-in
        </button>
      </Field>

      {only ? (
        <Field label="Account">
          <p className="text-sm font-medium">{only.name}</p>
          <p className="text-xs text-muted-foreground">{ROLE_NAMES[only.role]}</p>
        </Field>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium">Which account may this app use?</p>
          <ChoiceList
            label="Account for this app"
            value={selected}
            onChange={setChosen}
            choices={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              description: ROLE_NAMES[account.role],
            }))}
          />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium">What may it do?</p>
        <ChoiceList label="Grant for this app" choices={GRANTS} value={grant} onChange={setGrant} />
      </div>

      <Button type="submit" className="w-full" disabled={busy || !selected}>
        {allowing ? <Loader2 className="size-4 animate-spin" /> : null}
        Allow
      </Button>
    </form>
  );
}
