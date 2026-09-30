import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/pages/auth-shell";
import { call } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import {
  approvePathFor,
  normalizeUserCode,
  type ApproveNavigationState,
} from "@/lib/cli-approve";

/**
 * Where a person types the pairing code their terminal shows, for when
 * following the printed link is not convenient — the terminal is on another
 * machine, say.
 *
 * Outside the authenticated shell for the same reason the approval page is:
 * the person approving may not be signed in yet. The code only finds the
 * request; it is then carried to the approval page in navigation state, where
 * it stands in for the link's fragment proof, so it never appears in a URL.
 */
export function CliCodePage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const lookup = useMutation({
    mutationFn: (userCode: string) => call("cliBrowserLookup", { body: { userCode } }),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotFound(false);
    const userCode = normalizeUserCode(input);
    setInvalid(userCode === null);
    if (userCode === null) return;
    try {
      const result = await lookup.mutateAsync(userCode);
      if (!result.found) {
        setNotFound(true);
        return;
      }
      const state: ApproveNavigationState = { userCode };
      await navigate(approvePathFor(result.id), { state });
    } catch {
      // Rendered inline below; the mutation keeps the error.
    }
  };

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>Connect a CLI</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter the pairing code your terminal shows.
          </p>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cli-code">Pairing code</Label>
              <Input
                id="cli-code"
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
                  setNotFound(false);
                }}
              />
            </div>
            {invalid ? (
              <p role="alert" className="text-sm text-destructive">
                A pairing code is eight letters and digits, like ABCD-EFGH.
              </p>
            ) : notFound ? (
              <Alert role="alert">
                <AlertTitle>No request matches that code</AlertTitle>
                <AlertDescription>
                  Check it against your terminal. If the command has finished or timed out, run
                  it again for a new code.
                </AlertDescription>
              </Alert>
            ) : lookup.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {authErrorMessage(lookup.error, "Could not look up the code")}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={lookup.isPending || !input.trim()}>
              {lookup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Continue
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
