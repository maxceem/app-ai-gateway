import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/pages/auth-shell";
import { ApiError, call } from "@/lib/api";
import { clearStoredProof, readStoredProof, writeStoredProof } from "@/lib/stored-proof";

/**
 * Where a person enters a provider key an agent or the CLI asked for (v1's
 * approval page, cut to the two steps v2 has: adding a provider connection
 * and replacing its key).
 *
 * The link is the whole authority: whoever holds it may approve or decline,
 * signed in or not, and the write runs as the credential that asked for it.
 * The key goes from this page to the gateway and nowhere else: the agent that
 * sent the person here never sees it.
 *
 * The proof arrives in the URL fragment, which never leaves the browser. It
 * is stripped from the address bar on arrival and kept in `sessionStorage`
 * under this step's own path, so a reload still works.
 *
 * Outside the console's shell, like the consent page, and never framed (the
 * console-wide rule in `v2/console/public/_headers`).
 */

/** How long a step waits for its person, until its details say exactly. */
const PENDING_WINDOW_MS = 15 * 60_000;

function storageKeyFor(id: string): string {
  return `app-ai-gateway:approve:${id}`;
}

const HEADINGS = {
  "provider.add": "Add a provider connection",
  "provider.rotate-key": "Replace a provider key",
} as const;

/** What a refusal means to the person, by the gateway's code. */
function refusal(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Something went wrong. Try again.";
  if (error.status === 404) return "Nothing is waiting at this link. Check that you opened the whole link, or ask for a new one.";
  if (error.status === 403) return "This link is not valid. Open the whole link you were given, or ask for a new one.";
  if (error.status === 410) return "This link has expired. Ask for a new one.";
  return error.message;
}

export function ApprovePage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const storageKey = storageKeyFor(id);

  /*
    Resolved once, before the effect below rewrites the address bar, and kept
    in storage at once, so a reload while the details load still has it.
  */
  const [proof] = useState(() => {
    const fromLink = location.hash.replace(/^#/, "");
    if (fromLink) writeStoredProof(storageKey, { token: fromLink, expiresAt: Date.now() + PENDING_WINDOW_MS });
    return fromLink || readStoredProof(storageKey)?.token || "";
  });

  useEffect(() => {
    if (!location.hash) return;
    void navigate(`${location.pathname}${location.search}`, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  const details = useQuery({
    queryKey: ["handoff", id],
    queryFn: () => call("getHandoff", { params: { id }, body: { proof } }),
    enabled: Boolean(id && proof),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const data = details.data;
  useEffect(() => {
    if (!data) return;
    writeStoredProof(storageKey, { token: proof, expiresAt: Date.parse(data.expiresAt) });
  }, [data, storageKey, proof]);

  const [secret, setSecret] = useState("");
  const [answer, setAnswer] = useState<"completed" | "denied" | null>(null);

  const submit = useMutation({
    // Read from the field when sent, so the key is never kept as the
    // mutation's variables; the field is cleared once the answer comes.
    mutationFn: () => call("submitHandoff", { params: { id }, body: { proof, secret } }),
    gcTime: 0,
    onSuccess: () => {
      clearStoredProof(storageKey);
      setAnswer("completed");
    },
    onSettled: () => setSecret(""),
  });
  const deny = useMutation({
    mutationFn: () => call("denyHandoff", { params: { id }, body: { proof } }),
    onSuccess: () => {
      clearStoredProof(storageKey);
      setAnswer("denied");
    },
  });

  if (!id || !proof) {
    return (
      <ApproveShell id={id} title="Approve a request">
        <Alert variant="destructive" role="alert">
          <AlertTitle>This link is missing its proof</AlertTitle>
          <AlertDescription>Open the whole link you were given, or ask for a new one.</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  if (details.isPending) {
    return (
      <ApproveShell id={id} title="Approve a request">
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ApproveShell>
    );
  }

  if (details.isError || !data) {
    return (
      <ApproveShell id={id} title="Approve a request">
        <Alert variant="destructive" role="alert">
          <AlertTitle>This request cannot be answered</AlertTitle>
          <AlertDescription>{refusal(details.error)}</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  const title = HEADINGS[data.kind];
  const state = answer ?? data.state;

  if (state === "completed") {
    return (
      <ApproveShell id={id} title={title}>
        <Alert role="status">
          <CheckCircle2 className="size-4" />
          <AlertTitle>{data.kind === "provider.add" ? "Provider connection added" : "Key replaced"}</AlertTitle>
          <AlertDescription>You can close this tab and return to the agent or CLI that asked.</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }
  if (state === "denied") {
    return (
      <ApproveShell id={id} title={title}>
        <Alert role="status">
          <XCircle className="size-4" />
          <AlertTitle>Declined</AlertTitle>
          <AlertDescription>Nothing was changed. The agent or CLI that asked will be told.</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }
  if (state !== "pending") {
    return (
      <ApproveShell id={id} title={title}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This link has expired</AlertTitle>
          <AlertDescription>Nothing was changed. Ask for a new link.</AlertDescription>
        </Alert>
      </ApproveShell>
    );
  }

  const busy = submit.isPending || deny.isPending;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (secret.trim() === "" || busy) return;
    submit.mutate();
  };
  const { review } = data;
  const custom = review.baseUrl !== null;

  return (
    <ApproveShell id={id} title={title}>
      <p className="text-sm text-muted-foreground">
        {data.kind === "provider.add"
          ? "An agent or the CLI asked to add this provider connection. Enter its key to approve."
          : "An agent or the CLI asked to replace this connection's key. Enter the new key to approve."}
        {custom ? null : " The gateway keeps the key and sends it only to the provider, never to whoever asked."}
      </p>
      {custom ? (
        <Alert role="note">
          <AlertTitle>This request names its own address</AlertTitle>
          <AlertDescription>
            The gateway will send the key to {review.destinations.join(", ")}. Whoever controls that address receives the key. Approve only
            if you trust it.
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="break-all">
          {data.account.name} <span className="font-mono text-xs text-muted-foreground">{data.account.id}</span>
        </dd>
        <dt className="text-muted-foreground">Name</dt>
        <dd className="break-all">{review.name}</dd>
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="break-all">{review.type}</dd>
        <dt className="text-muted-foreground">Slug</dt>
        <dd className="font-mono break-all">{review.slug}</dd>
        <dt className="text-muted-foreground">Key sent to</dt>
        <dd className="font-mono break-all">
          {review.destinations.map((destination) => (
            <div key={destination}>{destination}</div>
          ))}
        </dd>
        {review.secretHint ? (
          <>
            <dt className="text-muted-foreground">Current key</dt>
            <dd className="font-mono">…{review.secretHint}</dd>
          </>
        ) : null}
      </dl>
      <form className="space-y-3" onSubmit={onSubmit}>
        <fieldset disabled={busy} className="space-y-2">
          <Label htmlFor="handoff-secret">{data.kind === "provider.add" ? "Provider key" : "New provider key"}</Label>
          <Input
            id="handoff-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </fieldset>
        {submit.isError || deny.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{submit.isError ? "Not approved" : "Not declined"}</AlertTitle>
            <AlertDescription>{refusal(submit.error ?? deny.error)}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1" disabled={busy || secret.trim() === ""}>
            {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Approve
          </Button>
          <Button type="button" variant="outline" className="flex-1" disabled={busy} onClick={() => deny.mutate()}>
            Decline
          </Button>
        </div>
      </form>
    </ApproveShell>
  );
}

function ApproveShell({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-3">
        <Card className="w-full">
          <CardHeader className="grid-rows-[auto] gap-0">
            <CardTitle>{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
        <p className="px-1 font-mono text-xs break-all text-muted-foreground">{id}</p>
      </div>
    </AuthLayout>
  );
}
