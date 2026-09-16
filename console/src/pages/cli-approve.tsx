import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { operations } from "@contracts/operations";
import type { CliBrowserDetailsResponse, CliOperationKind } from "@contracts/cli";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { call } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { useSignIn } from "@/lib/queries";

/**
 * The human half of a CLI browser handoff.
 *
 * Rendered by the console rather than by the Worker, so the screen a person is
 * sent to from their terminal is the same screen they would sign in on. It is
 * deliberately outside the authenticated shell: an account claim is the one
 * handoff whose whole point is that nobody is signed in yet.
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

  const [approved, setApproved] = useState(false);
  const submit = useMutation({
    mutationFn: (body: { approve: true; allowServiceAccess?: boolean; secret?: string }) =>
      call(operations.cliBrowserSubmit, [id], { submissionToken: token, ...body }),
    onSuccess: () => {
      clearStoredProof(storageKey);
      setApproved(true);
    },
  });

  if (!token) {
    return (
      <ApproveShell>
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
      <ApproveShell>
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ApproveShell>
    );
  }

  if (details.isError || !data) {
    return (
      <ApproveShell>
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

  if (approved) {
    return (
      <ApproveShell title={headingFor(data.kind)}>
        <Alert role="status">
          <CheckCircle2 className="size-4" />
          <AlertTitle>Approved</AlertTitle>
          <AlertDescription>Return to your CLI.</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  const identity = data.kind === "claim";

  return (
    <ApproveShell title={headingFor(data.kind)}>
      <Summary details={data} />

      {identity && !data.signedIn ? (
        <ClaimSignIn
          id={id}
          token={token}
          googleEnabled={data.googleEnabled}
          onDone={() => void details.refetch()}
        />
      ) : (
        <ApprovalForm
          details={data}
          pending={submit.isPending}
          error={submit.isError ? authErrorMessage(submit.error, "Approval failed") : null}
          onSubmit={(body) => submit.mutate(body)}
        />
      )}

      <Footnote details={data} id={id} />
    </ApproveShell>
  );
}

function ApproveShell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>{title ?? "Approve a CLI request"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </AuthLayout>
  );
}

/** The account and configuration a person compares against their terminal. */
function Summary({ details }: { details: CliBrowserDetailsResponse }) {
  const configuration =
    details.kind === "claim" || Object.keys(details.payload).length === 0
      ? null
      : JSON.stringify(details.payload, null, 2);
  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/40 px-3 py-2">
        <p className="text-sm font-medium">{details.account.name}</p>
        <p className="font-mono text-xs text-muted-foreground">{shortId(details.account.id)}</p>
      </div>
      {configuration ? (
        <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {configuration}
        </pre>
      ) : null}
    </div>
  );
}

function Footnote({ details, id }: { details: CliBrowserDetailsResponse; id: string }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="font-mono break-all">{id}</p>
      <p>Expires {new Date(details.expiresAt).toLocaleString()}.</p>
      <p>
        This page never displays management credentials. Provider credentials are submitted
        directly to your gateway.
      </p>
    </div>
  );
}

/**
 * Sign in or create an account, for a claim only.
 *
 * Both doors are offered because either can claim: an account someone already
 * has, or the first one this deployment gets. Registration goes through the
 * handoff's own endpoint rather than public sign-up, since a deployment that
 * refuses public registration still has to let its first person in.
 */
function ClaimSignIn({
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
  const [creating, setCreating] = useState(false);
  const signIn = useSignIn();
  const register = useMutation({
    mutationFn: (input: { name: string; email: string; password: string }) =>
      call(operations.cliBrowserRegister, [id], { submissionToken: token, ...input }),
  });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const active = creating ? register : signIn;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (creating) {
        await register.mutateAsync({
          name: name.trim(),
          email: email.trim(),
          password,
        });
      } else {
        await signIn.mutateAsync({ email: email.trim(), password });
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
        Sign in to confirm who is claiming this account.
      </p>

      {googleEnabled ? (
        <GoogleButton
          label={creating ? "Sign up with Google" : "Continue with Google"}
          onStart={startGoogle}
        />
      ) : null}

      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        {creating ? (
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
        ) : null}
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
            autoComplete={creating ? "new-password" : "current-password"}
            placeholder="••••••••••••"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {active.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authErrorMessage(active.error, creating ? "Sign-up failed" : "Sign-in failed")}
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={active.isPending}>
          {active.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {creating ? "Create account" : "Sign in"}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        {creating ? "Already have an account? " : "No account? "}
        <button
          type="button"
          className="text-primary-ink underline underline-offset-4"
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? "Sign in" : "Create one"}
        </button>
      </p>
    </div>
  );
}

function ApprovalForm({
  details,
  pending,
  error,
  onSubmit,
}: {
  details: CliBrowserDetailsResponse;
  pending: boolean;
  error: string | null;
  onSubmit: (body: { approve: true; allowServiceAccess?: boolean; secret?: string }) => void;
}) {
  const identity = details.kind === "claim";
  const secretRequired = needsSecret(details);
  const [secret, setSecret] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [keepAccess, setKeepAccess] = useState(true);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmed || (secretRequired && !secret)) return;
    onSubmit({
      approve: true,
      ...(identity ? { allowServiceAccess: keepAccess } : {}),
      ...(secretRequired ? { secret } : {}),
    });
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
        </div>
      ) : null}

      <div className="flex items-start gap-2">
        <Checkbox
          id="approve-confirm"
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
        />
        <Label htmlFor="approve-confirm" className="text-sm leading-snug font-normal">
          I approve this action for the account shown above
        </Label>
      </div>

      {identity ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id="approve-service-access"
            checked={keepAccess}
            onCheckedChange={(value) => setKeepAccess(value === true)}
          />
          <Label htmlFor="approve-service-access" className="text-sm leading-snug font-normal">
            Keep this service identity and its role-based management access
          </Label>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        className="w-full"
        disabled={pending || !confirmed || (secretRequired && !secret)}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Approve request
      </Button>
    </form>
  );
}
