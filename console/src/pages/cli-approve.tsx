import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { operations } from "@contracts/operations";
import type {
  CliBrowserDetailsResponse,
  CliBrowserSubmitResponse,
  CliOperationKind,
} from "@contracts/cli";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { call } from "@/lib/api";
import { DEFAULT_LANDING, oauthErrorNotice } from "@/lib/auth-redirect";
import { authErrorMessage, isSignInTaken } from "@/lib/auth-errors";
import { useSignIn, useSignOut } from "@/lib/queries";

/**
 * The human half of a CLI browser handoff.
 *
 * Rendered by the console rather than by the Worker, so the screen a person is
 * sent to from their terminal is the same screen they would sign in on. It is
 * deliberately outside the authenticated shell: an account claim is the one
 * handoff whose whole point is that nobody is signed in yet.
 *
 * What the page offers for a claim is not decided here. The gateway answers
 * every details request with `blockedBy`, the same verdict its submission
 * endpoint would reach, so the button this page shows and the answer pressing
 * it would get can never disagree. Its ending is the gateway's too: the
 * approval answers with the sentence to show and with `continueTo`, which says
 * whether this browser has anywhere to go afterwards or the terminal has the
 * rest.
 *
 * The submission proof arrives in the URL fragment, which never leaves the
 * browser. This page strips it from the address bar on arrival, keeps it in
 * `sessionStorage` under the operation's own path so it survives the Google
 * consent round trip, and sends it to nothing but the four handoff endpoints.
 */

/** A proof held only for this tab, only for this operation, only until it expires. */
interface StoredProof {
  token: string;
  expiresAt: number;
}

function storageKeyFor(pathname: string): string {
  return `app-ai-gateway:cli-approve:${pathname}`;
}

function readStoredProof(key: string): StoredProof | null {
  let stored: StoredProof | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(key) ?? "null") as StoredProof | null;
  } catch {
    stored = null;
  }
  if (!stored || typeof stored.token !== "string") return null;
  // A proof the gateway would refuse anyway is not worth keeping around.
  if (!(stored.expiresAt > Date.now())) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Nothing to clear when storage is unavailable. */
    }
    return null;
  }
  return stored;
}

function writeStoredProof(key: string, value: StoredProof): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private modes refuse; the proof simply does not survive a redirect. */
  }
}

function clearStoredProof(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* Already unreachable. */
  }
}

/**
 * What the heading says this handoff does.
 *
 * Derived from the kind rather than listed exhaustively, so a handoff kind
 * added to the contract still gets a sentence rather than a blank card.
 */
export function headingFor(kind: CliOperationKind | string): string {
  if (kind === "claim") return "Claim your account";
  const [subject, action] = kind.split(".");
  const noun = subject === "provider-gateway" ? "provider gateway" : "provider";
  if (action === "add") return `Add a ${noun}`;
  if (action === "rotate-key") return `Rotate the ${noun} credential`;
  if (action === "update") return `Update the ${noun}`;
  return `Approve a ${noun} change`;
}

/** Enough of an account id to compare with the terminal, not enough to read aloud. */
export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/** Provider handoffs carry the secret; a gateway-routed provider has none of its own. */
function needsSecret(details: CliBrowserDetailsResponse): boolean {
  if (details.kind === "claim") return false;
  return !(details.kind === "provider.add" && details.payload.providerGatewayId);
}

export function CliApprovePage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const storageKey = storageKeyFor(location.pathname);

  /*
   * Resolved once, before the effect below rewrites the address bar. The hash
   * wins when it is there; the stored copy is what brings the page back to life
   * after Google returns the browser to this same path without one.
   */
  const [token] = useState(
    () => location.hash.replace(/^#/, "") || readStoredProof(storageKey)?.token || "",
  );

  useEffect(() => {
    if (!location.hash) return;
    void navigate(`${location.pathname}${location.search}`, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  /*
   * A Google attempt that failed comes back to this same page as `?error=…`,
   * because a provider redirect has no response body to carry a reason. The
   * claim is still finishable here with a password, so the reason is shown
   * here rather than sent anywhere else.
   */
  const oauthError = oauthErrorNotice(location.search);

  const details = useQuery({
    queryKey: ["cli-approve", id],
    queryFn: () => call(operations.cliBrowserDetails, [id], { submissionToken: token }),
    enabled: Boolean(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const data = details.data;
  useEffect(() => {
    if (!data) return;
    writeStoredProof(storageKey, { token, expiresAt: Date.parse(data.expiresAt) });
  }, [data, storageKey, token]);

  /* The gateway's own account of the approval, which is also the whole of what
     the final screen says and offers. */
  const [outcome, setOutcome] = useState<CliBrowserSubmitResponse | null>(null);
  const submit = useMutation({
    mutationFn: (body: { approve: true; secret?: string }) =>
      call(operations.cliBrowserSubmit, [id], { submissionToken: token, ...body }),
    onSuccess: (result) => {
      clearStoredProof(storageKey);
      setOutcome(result);
    },
  });

  if (!token) {
    return (
      <ApproveShell id={id}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This link is missing its proof</AlertTitle>
          <AlertDescription>
            Open the full link your CLI printed, or rerun the command to get a new one.
          </AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  if (details.isPending) {
    return (
      <ApproveShell id={id}>
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ApproveShell>
    );
  }

  if (details.isError || !data) {
    return (
      <ApproveShell id={id}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This request can no longer be approved</AlertTitle>
          <AlertDescription>
            {authErrorMessage(details.error, "The link has expired or was already used.")} Rerun
            the command in your CLI to start a new one.
          </AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  if (outcome) {
    return (
      <ApproveShell title={headingFor(data.kind)} id={id} expiresAt={data.expiresAt}>
        <Alert role="status">
          <CheckCircle2 className="size-4" />
          <AlertTitle>Approved</AlertTitle>
          <AlertDescription>{outcome.message}</AlertDescription>
        </Alert>
        {/*
          Offered only where the gateway says this browser has somewhere to go.
          A claim leaves its approver signed in on the account they just took,
          so the link lands them in the console; every other handoff leaves this
          tab with nothing, and the sentence above says so instead.
        */}
        {outcome.continueTo === "console" ? (
          <Button asChild className="w-full">
            <Link to={DEFAULT_LANDING}>Go to your console</Link>
          </Button>
        ) : null}
      </ApproveShell>
    );
  }

  return (
    <ApproveShell title={headingFor(data.kind)} id={id} expiresAt={data.expiresAt}>
      {oauthError ? (
        <Alert variant={oauthError.tone} role="alert">
          <AlertTitle>{oauthError.title}</AlertTitle>
          <AlertDescription>{oauthError.description}</AlertDescription>
        </Alert>
      ) : null}

      <Summary details={data} />

      {data.blockedBy === "registration_required" ? (
        <ClaimRegister
          id={id}
          token={token}
          googleEnabled={data.googleEnabled}
          onDone={() => void details.refetch()}
        />
      ) : data.blockedBy === "sign_out_required" ? (
        <SignOutFirst viewer={data.viewer} onDone={() => void details.refetch()} />
      ) : (
        <ApprovalForm
          details={data}
          pending={submit.isPending}
          error={submit.isError ? authErrorMessage(submit.error, "Approval failed") : null}
          onSubmit={(body) => submit.mutate(body)}
        />
      )}
    </ApproveShell>
  );
}

/**
 * The card, and under it what identifies the request rather than describes it.
 *
 * The operation id and its deadline sit outside the card on every state, so the
 * card holds only what a person acts on. The id is known from the URL even when
 * nothing else loaded, which is exactly when someone needs to read it out.
 */
function ApproveShell({
  title,
  id,
  expiresAt,
  children,
}: {
  title?: string;
  id: string;
  expiresAt?: string;
  children: React.ReactNode;
}) {
  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-3">
        <Card className="w-full">
          <CardHeader className="grid-rows-[auto] gap-0">
            <CardTitle>{title ?? "Approve a CLI request"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
        <Footnote id={id} expiresAt={expiresAt} />
      </div>
    </AuthLayout>
  );
}

/**
 * The account, the person and the configuration, as a terminal can confirm them.
 *
 * Both identities are named, because they are not the same one and a claim is
 * where confusing them costs most: the account is what the CLI is acting on,
 * the viewer is whichever human this browser happens to be signed in as — and
 * for a claim, the wrong one there is what sends this page to `SignOutFirst`
 * instead of the approval button.
 */
function Summary({ details }: { details: CliBrowserDetailsResponse }) {
  const configuration =
    details.kind === "claim" || Object.keys(details.payload).length === 0
      ? null
      : JSON.stringify(details.payload, null, 2);
  return (
    <div className="space-y-3">
      <Field label="Account">
        <p className="text-sm font-medium">{details.account.name}</p>
        <p className="font-mono text-xs text-muted-foreground">{shortId(details.account.id)}</p>
      </Field>
      {details.viewer ? (
        <Field label="Approving as">
          <p className="text-sm font-medium">{details.viewer.name ?? "Signed-in user"}</p>
          {details.viewer.email ? (
            <p className="text-xs text-muted-foreground">{details.viewer.email}</p>
          ) : null}
        </Field>
      ) : null}
      {configuration ? (
        <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {configuration}
        </pre>
      ) : null}
    </div>
  );
}

/** A labelled read-only box; the label is what tells two identities apart. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

function Footnote({ id, expiresAt }: { id: string; expiresAt?: string }) {
  return (
    <div className="space-y-0.5 px-1 text-xs text-muted-foreground">
      <p className="font-mono break-all">{id}</p>
      {expiresAt ? <p>Expires {new Date(expiresAt).toLocaleString()}.</p> : null}
    </div>
  );
}

/**
 * How a person becomes the owner a claim is waiting for.
 *
 * Registration is the only thing offered, because it is the only thing that
 * ends in an approvable claim. Someone who signs in arrives with an account
 * already, and that is exactly what the sign-out screen next door refuses, so
 * a standing "sign in instead" here would reopen the door this whole rule
 * exists to shut. It goes through the handoff's own endpoint rather than
 * public sign-up, since a deployment that refuses public registration still
 * has to let its first person in.
 *
 * Signing in appears exactly once, as the answer to a question a person has
 * already been asked: a registration refused because that email is taken.
 * Whoever registered here for a claim that then expired owns an account
 * attached to nothing, and this is the only screen that can tell them so. It
 * is reached by failing, never by choosing.
 */
function ClaimRegister({
  id,
  token,
  googleEnabled,
  onDone,
}: {
  id: string;
  token: string;
  googleEnabled: boolean;
  onDone: () => void;
}) {
  const signIn = useSignIn();
  const register = useMutation({
    mutationFn: (input: { name: string; email: string; password: string }) =>
      call(operations.cliBrowserRegister, [id], { submissionToken: token, ...input }),
  });
  /* Entered only from the refusal below, which is why nothing sets it back. */
  const [recovering, setRecovering] = useState(false);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const active = recovering ? signIn : register;
  const taken = !recovering && register.isError && isSignInTaken(register.error);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (recovering) {
        await signIn.mutateAsync({ email: email.trim(), password });
      } else {
        await register.mutateAsync({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      }
      setPassword("");
      onDone();
    } catch {
      // Rendered inline below; the mutation keeps the error.
    }
  };

  const startGoogle = async () => {
    const result = await call(operations.cliBrowserGoogle, [id], { submissionToken: token });
    if (!result.url) throw new Error("Google sign-in is unavailable right now.");
    window.location.assign(result.url);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {recovering
          ? "Sign in to the account you already created for this claim."
          : "Create your account to claim."}
      </p>

      {googleEnabled ? (
        <GoogleButton
          label={recovering ? "Continue with Google" : "Sign up with Google"}
          onStart={startGoogle}
        />
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        {recovering ? null : (
          <div className="space-y-2">
            <Label htmlFor="claim-name">Name</Label>
            <Input
              id="claim-name"
              value={name}
              required
              autoComplete="name"
              placeholder="Ada Lovelace"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="claim-email">Email</Label>
          <Input
            id="claim-email"
            type="email"
            value={email}
            required
            autoComplete="username"
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="claim-password">Password</Label>
          <Input
            id="claim-password"
            type="password"
            value={password}
            required
            autoComplete={recovering ? "current-password" : "new-password"}
            placeholder="••••••••••••"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {taken ? (
          <Alert role="alert">
            <AlertTitle>That email already has an account</AlertTitle>
            <AlertDescription className="space-y-3">
              <span>
                If you created it here for a claim you never finished, sign in to carry on.
                Otherwise use another email.
              </span>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setRecovering(true)}
              >
                Sign in to it instead
              </Button>
            </AlertDescription>
          </Alert>
        ) : active.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(active.error, recovering ? "Sign-in failed" : "Sign-up failed")}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={active.isPending}>
          {active.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {recovering ? "Sign in" : "Create account"}
        </Button>
      </form>
    </div>
  );
}

/**
 * The one way out for a browser already signed in as somebody with an account.
 *
 * A claim settles this account on a person who has no other, so there is
 * nothing to decide here beyond leaving the current session: signing out
 * returns the page to the account creation form, without a navigation that
 * would drop the proof this tab is holding.
 */
function SignOutFirst({
  viewer,
  onDone,
}: {
  viewer: CliBrowserDetailsResponse["viewer"];
  onDone: () => void;
}) {
  const signOut = useSignOut();
  // The gateway only reaches this verdict from a signed-in human, so there is
  // always a name or an address to put in front of them.
  const who = viewer?.name ?? viewer?.email;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {who} is signed in and already owns an account. This one must be claimed by a new
        person, so sign out first, then create your account on this page.
      </p>
      <Button
        type="button"
        className="w-full"
        disabled={signOut.isPending}
        onClick={() => signOut.mutate(undefined, { onSettled: onDone })}
      >
        {signOut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Sign out
      </Button>
    </div>
  );
}

/**
 * The approval itself.
 *
 * Pressing the button is the consent: a checkbox in front of it would only ask
 * the same question twice, and the summary above already names what is being
 * approved and who is approving it. A claim keeps the CLI's access, so there is
 * nothing else to decide here either.
 */
function ApprovalForm({
  details,
  pending,
  error,
  onSubmit,
}: {
  details: CliBrowserDetailsResponse;
  pending: boolean;
  error: string | null;
  onSubmit: (body: { approve: true; secret?: string }) => void;
}) {
  const secretRequired = needsSecret(details);
  const [secret, setSecret] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (secretRequired && !secret) return;
    onSubmit({ approve: true, ...(secretRequired ? { secret } : {}) });
    // Nothing on this page needs the value again, whatever the answer is.
    setSecret("");
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {secretRequired ? (
        <div className="space-y-2">
          <Label htmlFor="approve-secret">Provider credential</Label>
          <Input
            id="approve-secret"
            type="password"
            value={secret}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="••••••••••••"
            onChange={(event) => setSecret(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Submitted directly to your gateway and stored encrypted. Only a hint of it is
            ever shown again.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending || (secretRequired && !secret)}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Approve request
      </Button>
    </form>
  );
}
