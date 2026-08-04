import { useState, type FormEvent } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/lib/queries";

export function LoginPage() {
  const login = useLogin();
  const [token, setToken] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) login.mutate(token.trim());
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
            <KeyRound className="size-4" />
          </div>
          <CardTitle>AI Gateway Console</CardTitle>
          <CardDescription>
            Sign in with the gateway&rsquo;s <code className="font-mono">ADMIN_TOKEN</code>. It is
            exchanged for a 12&nbsp;hour session cookie and never stored in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token">Admin token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                autoFocus
                autoComplete="current-password"
                placeholder="••••••••••••••••"
                onChange={(event) => setToken(event.target.value)}
              />
            </div>
            {login.isError ? (
              <p className="text-sm text-destructive">
                {login.error instanceof Error ? login.error.message : "Sign-in failed"}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={login.isPending || !token.trim()}>
              {login.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
