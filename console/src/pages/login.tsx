import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { authErrorMessage } from "@/lib/auth-errors";
import { oauthErrorNotice, returnPathFrom } from "@/lib/auth-redirect";
import { useCapabilities, useSignIn } from "@/lib/queries";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const capabilities = useCapabilities();
  const signIn = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // A provider redirect reports failure in the query string, not a response body.
  const oauthError = oauthErrorNotice(location.search);
  const returnPath = returnPathFrom(location.search);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    try {
      await signIn.mutateAsync({ email: email.trim(), password });
      await navigate(returnPath, { replace: true });
    } catch {
      // Rendered inline below; the mutation keeps the error.
    }
  };

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {oauthError ? (
            <Alert variant={oauthError.tone} role="alert">
              <AlertTitle>{oauthError.title}</AlertTitle>
              <AlertDescription>{oauthError.description}</AlertDescription>
            </Alert>
          ) : null}

          {capabilities.data?.googleAuth ? <GoogleButton returnPath={returnPath} /> : null}

          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                autoFocus
                required
                autoComplete="username"
                placeholder="operator@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                required
                autoComplete="current-password"
                placeholder="••••••••••••"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {signIn.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {authErrorMessage(signIn.error, "Sign-in failed")}
              </p>
            ) : null}
            <Button
              type="submit"
              className="w-full"
              disabled={signIn.isPending || !email.trim() || !password}
            >
              {signIn.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Sign in
            </Button>
          </form>

          {capabilities.data?.registrationOpen ? (
            <p className="text-center text-sm text-muted-foreground">
              No account?{" "}
              <Link to="/signup" className="text-foreground underline underline-offset-4">
                Create one
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
