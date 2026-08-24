import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { startGoogleSignIn } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";

/** The centered, unauthenticated frame shared by sign-in and sign-up. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
        <span>App</span>
        <span className="grid size-7 place-items-center rounded bg-primary text-xs font-bold text-primary-foreground">
          AI
        </span>
        <span>Gateway</span>
      </div>
      {children}
    </div>
  );
}

/** Rendered only when the deployment reports the `googleAuth` capability. */
export function GoogleButton({ label = "Continue with Google" }: { label?: string }) {
  const [pending, setPending] = useState(false);

  const start = async () => {
    setPending(true);
    try {
      // Navigates away on success, so `pending` intentionally stays true.
      await startGoogleSignIn();
    } catch (error) {
      setPending(false);
      toast.error(authErrorMessage(error, "Could not start Google sign-in"));
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending}
        onClick={() => void start()}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <GoogleMark />}
        {label}
      </Button>
    </>
  );
}

function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.92l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.95H1.26v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.26a12 12 0 0 0 0 10.76l4.01-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.62l4.01 3.1C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}
