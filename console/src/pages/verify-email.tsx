import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, MailX } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AuthLayout } from "@/pages/auth-shell";
import { authErrorMessage } from "@/lib/auth-errors";
import { DEFAULT_LANDING } from "@/lib/auth-redirect";
import { useConfirmEmailVerification } from "@/lib/queries";

/**
 * Where the link in a verification email lands.
 *
 * Outside the console's shell, like the approval page: a person is sent here
 * by a link, often on another device than the one that asked for it, and the
 * link alone proves the address, so nobody has to be signed in. The token is
 * read once and taken out of the address bar, so it is not left in the
 * browser's history; confirming it again is harmless, which is what lets a
 * remount or a reload confirm it a second time.
 */
export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(location.search).get("token"));
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
              {confirm.data.returnTo ? (
                <Button asChild className="w-full">
                  <Link to={confirm.data.returnTo}>Continue</Link>
                </Button>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    If you were approving a request in another tab, go back to it and continue there.
                  </p>
                  <Button asChild variant="outline" className="w-full">
                    <Link to={DEFAULT_LANDING}>Open the console</Link>
                  </Button>
                </>
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
