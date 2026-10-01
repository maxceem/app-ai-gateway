import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import type { OperationStatusResponse, RevealedOperationResponse } from "@contracts/responses";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretRevealDialog } from "@/components/secret-reveal-dialog";
import { AuthLayout } from "@/pages/auth-shell";
import { ApiError, call } from "@/lib/api";
import { DEFAULT_LANDING } from "@/lib/auth-redirect";

/**
 * Where a person sees, once, a key an agent created for them.
 *
 * An MCP tool that creates a server app or an app key never answers the key:
 * it answers this page's URL, and the person who asked the agent opens it,
 * signed in as an owner or admin of the account. The page first shows what
 * would be revealed — read from the operation's status, which hands nothing
 * over — and reveals only when the person presses the button: a link that is
 * prefetched, previewed or opened by something other than them must not spend
 * the one delivery there is.
 *
 * Outside the console's shell, like the CLI's approval page, because it is a
 * page a person is sent to rather than one they navigate to. Without a session
 * the console's global handling of `401` sends them to sign in, and back here.
 * It is never framed by the console-wide rule in `console/public/_headers`,
 * which covers it however it is reached, client-side navigation included.
 */

/** What a refused reveal means to the person, by the gateway's code. */
const REFUSALS: Record<string, string> = {
  already_revealed: "This key was already revealed. It is shown only once; create a new key if it was not saved.",
  operation_expired:
    "This key can no longer be revealed: the 15 minutes to reveal it have passed, or it was revoked. Create a new key instead.",
  operation_not_found: "No operation of this account has this id. Check that you are signed in to the account the key was created in.",
  session_required: "Revealing a key needs you signed in to the console in this browser.",
  forbidden: "Only an owner or admin of the account can reveal a key.",
};

function refusal(error: unknown): string {
  if (error instanceof ApiError) return REFUSALS[error.code] ?? error.message;
  return error instanceof Error ? error.message : "The key could not be revealed.";
}

/** What the operation created, in a person's words. */
function described(status: OperationStatusResponse): { what: string; name: string | null } {
  const app = status.result?.app;
  const key = status.result?.api_key;
  if (status.kind.startsWith("app.key.add")) {
    return { what: "A new API key", name: key?.name ?? null };
  }
  return { what: app ? `The key of the new app "${app.name}"` : "The key of a new app", name: app?.id ?? null };
}

export function RevealPage() {
  const { id = "" } = useParams();
  const status = useQuery({
    queryKey: ["operation", id],
    queryFn: () => call("getOperation", { params: { id } }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [revealed, setRevealed] = useState<RevealedOperationResponse | null>(null);
  const [saved, setSaved] = useState(false);
  const reveal = useMutation({
    mutationFn: () => call("revealOperation", { params: { id } }),
    onSuccess: (result) => setRevealed(result),
  });

  if (status.isPending) {
    return (
      <RevealShell id={id}>
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </RevealShell>
    );
  }

  if (status.isError || !status.data) {
    return (
      <RevealShell id={id}>
        <Alert variant="destructive" role="alert">
          <AlertTitle>This key cannot be revealed</AlertTitle>
          <AlertDescription>{refusal(status.error)}</AlertDescription>
        </Alert>
      </RevealShell>
    );
  }

  const data = status.data;
  const { what, name } = described(data);

  if (saved) {
    return (
      <RevealShell id={id}>
        <Alert role="status">
          <CheckCircle2 className="size-4" />
          <AlertTitle>Key revealed</AlertTitle>
          <AlertDescription>
            It was shown once and will not be shown again. You can close this tab.
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="w-full">
          <Link to={DEFAULT_LANDING}>Go to your console</Link>
        </Button>
      </RevealShell>
    );
  }

  return (
    <RevealShell id={id}>
      <div className="space-y-1 text-sm">
        <p className="font-medium">{what}</p>
        {name ? <p className="font-mono text-xs text-muted-foreground break-all">{name}</p> : null}
      </div>

      {data.reveal_url === undefined ? (
        <Alert role="status">
          <AlertTitle>{data.state === "completed" ? "No longer available" : "Nothing to reveal"}</AlertTitle>
          <AlertDescription>
            {/*
              Neutral on purpose: the status says only that nothing is held,
              which is as true of a key revealed already as of one whose
              window passed with nobody revealing it.
            */}
            {data.state === "completed"
              ? "This key can no longer be revealed here. A key is shown once, within 15 minutes of its creation; if it was not saved, create a new key."
              : "This operation has not created a key that can be revealed."}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            The key is shown once, here, and never to the agent that created it. Reveal it when you
            are ready to copy it somewhere safe.
          </p>
          {reveal.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>The key was not revealed</AlertTitle>
              <AlertDescription>{refusal(reveal.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Button
            className="w-full"
            disabled={reveal.isPending || reveal.isError}
            onClick={() => reveal.mutate()}
          >
            {reveal.isPending ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            Reveal the key
          </Button>
        </>
      )}

      <SecretRevealDialog
        open={revealed !== null}
        title="Copy your new key now"
        description={
          <>
            This is the only time the plaintext of{" "}
            <span className="font-medium text-foreground">{revealed?.result.api_key?.name ?? "this key"}</span>{" "}
            is available — you will not see it again. The gateway stores only a hash.
          </>
        }
        label="API key"
        secret={revealed?.result.api_key?.key ?? ""}
        onAcknowledge={() => {
          setRevealed(null);
          setSaved(true);
          // The plaintext also sits in the mutation's cached result; drop it
          // so the only copy of a live credential is the person's.
          reveal.reset();
        }}
      />
    </RevealShell>
  );
}

function RevealShell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-3">
        <Card className="w-full">
          <CardHeader className="grid-rows-[auto] gap-0">
            <CardTitle>Reveal a key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">{children}</CardContent>
        </Card>
        <p className="px-1 font-mono text-xs break-all text-muted-foreground">{id}</p>
      </div>
    </AuthLayout>
  );
}
