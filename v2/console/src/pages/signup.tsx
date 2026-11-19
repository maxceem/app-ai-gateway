import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2, Lock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout, GoogleButton } from "@/pages/auth-shell";
import { authErrorMessage } from "@/lib/auth-errors";
import { loginUrlFor, postAuthPath } from "@/lib/auth-redirect";
import { useCapabilities, useSignUp } from "@/lib/queries";

const MIN_PASSWORD_LENGTH = 8;

export function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const capabilities = useCapabilities();
  const signUp = useSignUp();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Where this sign-up ends: the page the operator was headed for.
  const destination = postAuthPath(location.search);

  // Capabilities decide whether this screen exists at all.
  if (capabilities.isPending) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (capabilities.data && !capabilities.data.registrationOpen) {
    return <RegistrationClosed googleAuth={capabilities.data.googleAuth} />;
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const ready = name.trim() && email.trim() && password.length >= MIN_PASSWORD_LENGTH;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    try {
      await signUp.mutateAsync({ name: name.trim(), email: email.trim(), password });
      await navigate(destination, { replace: true });
    } catch {
      // Rendered inline below.
    }
  };

  // Registration is open, so a `registration_disabled` refusal is about this
  // email address: it shows under the form, where the person can change it.
  // Only a deployment that reports registration closed gets the closed screen.

  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader className="grid-rows-[auto] gap-0">
          <CardTitle>Create an account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {capabilities.data?.googleAuth ? (
            <GoogleButton label="Sign up with Google" returnPath={destination} />
          ) : null}

          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                autoFocus
                required
                autoComplete="name"
                placeholder="Ada Lovelace"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
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
                autoComplete="new-password"
                placeholder="••••••••••••"
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
            {tooShort ? (
              <p className="text-sm text-destructive">
                Use at least {MIN_PASSWORD_LENGTH} characters.
              </p>
            ) : null}
            {signUp.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {authErrorMessage(signUp.error, "Sign-up failed")}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={signUp.isPending || !ready}>
              {signUp.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create account
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              to={loginUrlFor(destination)}
              className="text-primary-ink underline underline-offset-4"
            >
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>

      {/* The deployment names its own terms and privacy policy, if it has
          them; a self-hosted one usually names neither. Outside the card,
          opposite the wordmark, keeps the fine print clear of the form. */}
      <LegalLine
        termsUrl={capabilities.data?.termsOfServiceUrl}
        privacyUrl={capabilities.data?.privacyPolicyUrl}
      />
    </AuthLayout>
  );
}

/**
 * A self-hosted deployment that lists no registration emails accepts no
 * sign-ups. The screen states that plainly rather than 404-ing, because
 * operators arrive here from bookmarks and shared links.
 */
function RegistrationClosed({ googleAuth }: { googleAuth: boolean }) {
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-9 place-items-center rounded-md bg-muted text-muted-foreground">
            <Lock className="size-4" />
          </div>
          <CardTitle>Registration is closed</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>This gateway does not accept public sign-ups</AlertTitle>
            <AlertDescription>
              Sign in with an existing account.
            </AlertDescription>
          </Alert>
          {googleAuth ? <GoogleButton label="Continue with Google" /> : null}
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}

const LEGAL_LINK = "underline underline-offset-4 hover:text-foreground";

/** "By creating an account you agree to…", naming only the documents the deployment has. */
function LegalLine({ termsUrl, privacyUrl }: { termsUrl?: string | undefined; privacyUrl?: string | undefined }) {
  if (!termsUrl && !privacyUrl) return null;
  const terms = termsUrl ? (
    <a href={termsUrl} target="_blank" rel="noopener" className={LEGAL_LINK}>Terms of Service</a>
  ) : null;
  const privacy = privacyUrl ? (
    <a href={privacyUrl} target="_blank" rel="noopener" className={LEGAL_LINK}>Privacy Policy</a>
  ) : null;
  return (
    <p className="max-w-sm text-center text-xs text-balance text-muted-foreground">
      By creating an account you agree to the {terms}
      {terms && privacy ? " and " : null}
      {privacy}.
    </p>
  );
}
