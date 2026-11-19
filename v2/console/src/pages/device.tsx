import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { call } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { loginUrlFor, signupUrlFor } from "@/lib/auth-redirect";
import { ROLE_LABELS } from "@/lib/permissions";
import { useCapabilities, useSession } from "@/lib/queries";
import type { DeviceDetails } from "@/lib/types";

/**
 * Where a person approves a CLI sign-in that started on a machine without a
 * browser (the OAuth device flow). The CLI prints this page's address and a
 * short code; the person types the code here, checks it matches the one on
 * their terminal, picks an account, and allows or denies.
 *
 * The CLI may also print the address with the code already filled in
 * (`?user_code=`). The code is then only put in the box: it is never sent on
 * its own, so a link someone else sent cannot sign a stranger's CLI in. The
 * person still compares the code with their terminal before allowing.
 *
 * Outside the authenticated shell, so a person who is not signed in yet is
 * offered sign-in here and brought back to this page. Never framed, by the
 * console-wide rule in `v2/console/public/_headers`.
 */
export function DevicePage() {
  const location = useLocation();
  const session = useSession();
  const prefilled = new URLSearchParams(location.search).get("user_code") ?? "";

  if (session.isPending) {
    return (
      <DeviceShell>
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </DeviceShell>
    );
  }

  return (
    <DeviceShell>
      {session.data ? <DeviceFlow prefilled={prefilled} /> : <SignedOut back={`${location.pathname}${location.search}`} />}
    </DeviceShell>
  );
}

function DeviceShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>Sign in a CLI</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </AuthLayout>
  );
}

/** Signing in, creating an account and Google each bring the browser back here. */
function SignedOut({ back }: { back: string }) {
  const capabilities = useCapabilities();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Sign in to choose which of your accounts the CLI may use.</p>
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

/** The code as typed: case and separators ignored. Null when it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/gu, "");
  if (!/^[A-Z0-9]{8}$/u.test(code)) return null;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The request the code found, with the code that now stands as its proof. */
interface Found {
  id: string;
  userCode: string;
}

function DeviceFlow({ prefilled }: { prefilled: string }) {
  const [found, setFound] = useState<Found | null>(null);
  if (found === null) return <CodeEntry prefilled={prefilled} onFound={setFound} />;
  return <Decision found={found} onRestart={() => setFound(null)} />;
}

/**
 * Typing the code. It only finds the request, counted per network address on
 * the gateway so codes cannot be guessed in bulk.
 */
function CodeEntry({ prefilled, onFound }: { prefilled: string; onFound: (found: Found) => void }) {
  const [input, setInput] = useState(prefilled);
  const [invalid, setInvalid] = useState(false);

  const lookup = useMutation({
    mutationFn: (userCode: string) => call("lookupDeviceCode", { body: { userCode } }),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const userCode = normalizeUserCode(input);
    setInvalid(userCode === null);
    if (userCode === null) return;
    try {
      const result = await lookup.mutateAsync(userCode);
      onFound({ id: result.id, userCode });
    } catch {
      // Rendered inline below; the mutation keeps the error.
    }
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">Enter the code your terminal shows.</p>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="device-code">Code</Label>
          <Input
            id="device-code"
            value={input}
            required
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={16}
            placeholder="ABCD-EFGH"
            className="font-mono tracking-widest uppercase"
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setInput(event.target.value);
              setInvalid(false);
              lookup.reset();
            }}
          />
        </div>
        {invalid ? (
          <p role="alert" className="text-sm text-destructive">
            A code is eight letters and digits, like ABCD-EFGH.
          </p>
        ) : lookup.isError ? (
          <Alert role="alert">
            <AlertTitle>No sign-in matches that code</AlertTitle>
            <AlertDescription>
              {authErrorMessage(lookup.error, "Could not look up the code.")} If the command has finished
              or timed out, run it again for a new code.
            </AlertDescription>
          </Alert>
        ) : null}
        <Button type="submit" className="w-full" disabled={lookup.isPending || !input.trim()}>
          {lookup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Continue
        </Button>
      </form>
    </>
  );
}

type Grant = DeviceDetails["requestedGrant"];

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

/** A labelled read-only box, as the consent page draws one. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

/**
 * The request the code found: the code to compare with the terminal, the
 * client, which account it gets and with how much of the person's role, then
 * Allow or Deny.
 */
function Decision({ found, onRestart }: { found: Found; onRestart: () => void }) {
  const details = useQuery({
    queryKey: ["device", found.id],
    queryFn: () => call("getDeviceRequest", { params: { id: found.id }, body: { userCode: found.userCode } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [answer, setAnswer] = useState<"completed" | "denied" | null>(null);

  const approve = useMutation({
    mutationFn: (body: { accountId: string; grant: Grant }) =>
      call("approveDeviceRequest", { params: { id: found.id }, body: { userCode: found.userCode, ...body } }),
    onSuccess: (result) => setAnswer(result.state),
  });
  const deny = useMutation({
    mutationFn: () => call("denyDeviceRequest", { params: { id: found.id }, body: { userCode: found.userCode } }),
    onSuccess: (result) => setAnswer(result.state),
  });

  if (details.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (details.isError || !details.data) {
    return (
      <>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This sign-in can no longer be approved</AlertTitle>
          <AlertDescription>
            {authErrorMessage(details.error, "It has expired or was already answered.")} Run the command
            again for a new code.
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" className="w-full" onClick={onRestart}>
          Enter another code
        </Button>
      </>
    );
  }

  if (answer !== null) {
    return (
      <Alert role="status">
        {answer === "denied" ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
        <AlertTitle>{answer === "denied" ? "Sign-in declined" : "CLI signed in"}</AlertTitle>
        <AlertDescription>
          {answer === "denied"
            ? "The CLI was told no. You can close this tab."
            : "Go back to your terminal: it continues by itself. You can close this tab."}
        </AlertDescription>
      </Alert>
    );
  }

  const data = details.data;
  const error = approve.isError
    ? authErrorMessage(approve.error, "The sign-in could not be approved")
    : deny.isError
      ? authErrorMessage(deny.error, "Could not decline the sign-in")
      : null;
  const busy = approve.isPending || deny.isPending;

  return (
    <>
      {data.state !== "pending" ? (
        <Settled state={data.state} />
      ) : data.accounts.length === 0 ? (
        <Alert role="alert">
          <AlertTitle>No account to connect</AlertTitle>
          <AlertDescription>
            You are not a member of any account the CLI can use. Ask an owner to add you, then try again.
          </AlertDescription>
        </Alert>
      ) : (
        <AllowForm
          details={data}
          busy={busy}
          approving={approve.isPending}
          onAllow={(body) => approve.mutate(body)}
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
    </>
  );
}

/** A request already answered, or past its ten minutes: nothing to offer. */
function Settled({ state }: { state: DeviceDetails["state"] }) {
  const [title, text] = state === "completed"
    ? ["Already approved", "This sign-in was approved already. You can close this tab."]
    : state === "denied"
      ? ["Declined", "This sign-in was declined. Run the command again if that was a mistake."]
      : ["This code has expired", "Run the command again for a new code."];
  return (
    <Alert role="status">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/**
 * The code to compare, the client, the account and the grant. One account
 * needs no question and is named; several are offered with none chosen,
 * because a default would choose for a person who did not look. The grant
 * starts at what the CLI asked for.
 */
function AllowForm({
  details,
  busy,
  approving,
  onAllow,
}: {
  details: DeviceDetails;
  busy: boolean;
  approving: boolean;
  onAllow: (body: { accountId: string; grant: Grant }) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant>(details.requestedGrant);
  const [matches, setMatches] = useState(false);
  const accounts = details.accounts;
  const only = accounts.length === 1 ? accounts[0]! : null;
  const selected = only ? only.id : accounts.some((account) => account.id === chosen) ? chosen : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected && matches) onAllow({ accountId: selected, grant });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Code">
        <p className="font-mono text-lg font-semibold tracking-widest">{details.userCode}</p>
        <p className="text-xs text-muted-foreground">It must be the same code your terminal shows.</p>
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={matches}
          onChange={(event) => setMatches(event.target.checked)}
        />
        <span>This is the code on my terminal.</span>
      </label>

      <Field label="App">
        {/* The client's name is its own claim: shown as text only. */}
        <p className="text-sm font-medium break-words">{details.client.name}</p>
        <p className="text-xs text-muted-foreground break-all">
          {details.client.domain ? `as declared by ${details.client.domain}` : "registered by this gateway"}
        </p>
      </Field>

      {only ? (
        <Field label="Account">
          <p className="text-sm font-medium">{only.name}</p>
          <p className="text-xs text-muted-foreground">{ROLE_LABELS[only.role]}</p>
        </Field>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium">Which account may the CLI use?</p>
          <ChoiceList
            label="Account for the CLI"
            value={selected}
            onChange={setChosen}
            choices={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              description: ROLE_LABELS[account.role],
            }))}
          />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-sm font-medium">What may it do?</p>
        <ChoiceList label="Grant for the CLI" choices={GRANTS} value={grant} onChange={setGrant} />
      </div>

      <Button type="submit" className="w-full" disabled={busy || !selected || !matches}>
        {approving ? <Loader2 className="size-4 animate-spin" /> : null}
        Allow
      </Button>
    </form>
  );
}
