import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, MailX } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuthLayout } from "@/pages/auth-shell";
import { authErrorMessage } from "@/lib/auth-errors";
import { DEFAULT_LANDING, isSafeReturnPath, routerPath } from "@/lib/auth-redirect";
import { useConfirmEmailVerification } from "@/lib/queries";

/**
 * Where the link in a verification email lands.
 *
 * Outside the console's shell, like the approval page: a person is sent here
 * by a link, often on another device than the one that asked for it, and the
 * link alone proves the address, so nobody has to be signed in. The token is
 * in the link's `#` fragment, which the browser never sends to the server, so
 * it reaches no request log; it is read once, posted in a body, and taken out
 * of the address bar, so it is not left in the browser's history either.
 * Confirming it again answers the same, which is what lets a remount or a
 * reload land well.
 */

/** The token from a link's fragment, `#token=…`. */
export function tokenFromHash(hash: string): string | null {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get("token");
}

/**
 * Where Continue goes: the console path the link names, as the router sees it.
 * The server writes it as a browser path, under the console's `/v2` base,
 * which the router adds itself. The path is judged again once it is in the
 * router's terms: normalising and taking off `/v2` can turn a safe-looking
 * path (`/v2//evil.test`, `/v2/\evil`) into one that leaves the console, and
 * such a path falls back to the landing page.
 */
export function continuePath(returnTo: string | null | undefined): string | null {
  if (!isSafeReturnPath(returnTo)) return null;
  const url = new URL(returnTo, "https://console.invalid");
  const path = `${routerPath(url.pathname)}${url.search}`;
  return isSafeReturnPath(path) && !path.includes("\\") ? path : DEFAULT_LANDING;
}
export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => tokenFromHash(location.hash));
  const confirm = useConfirmEmailVerification();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    confirm.mutate(token);
    void navigate(location.pathname, { replace: true });
  }, [confirm, location.pathname, navigate, token]);

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>Verify your email address</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!token ? (
            <Refused message="This link is missing its token. Open the link from the email again, or send a new one from the console." />
          ) : confirm.isSuccess ? (
            <>
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Email address verified</AlertTitle>
                <AlertDescription>
                  {confirm.data.email} is verified. Your apps serve requests from now on.
                </AlertDescription>
              </Alert>
              {continuePath(confirm.data.returnTo) !== null ? (
                <Button asChild className="w-full">
                  <Link to={continuePath(confirm.data.returnTo)!}>Continue</Link>
                </Button>
              ) : (
                <Button asChild variant="outline" className="w-full">
                  <Link to={DEFAULT_LANDING}>Open the console</Link>
                </Button>
              )}
            </>
          ) : confirm.isError ? (
            <Refused message={authErrorMessage(confirm.error, "This link could not be confirmed")} />
          ) : (
            <div className="flex justify-center py-6" aria-label="Verifying">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

function Refused({ message }: { message: string }) {
  return (
    <>
      <Alert variant="destructive" role="alert">
        <MailX />
        <AlertTitle>This link did not work</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <Button asChild variant="outline" className="w-full">
        <Link to={DEFAULT_LANDING}>Open the console</Link>
      </Button>
    </>
  );
}
