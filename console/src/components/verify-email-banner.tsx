import { Loader2, MailWarning } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authErrorMessage } from "@/lib/auth-errors";
import { useConsoleSession } from "@/lib/console-session";
import { useSendVerificationEmail } from "@/lib/queries";

/**
 * Asks a person to verify their address, above every page, where the
 * deployment verifies them.
 *
 * It says the account's apps are refused only where the gateway says they are
 * (`verificationPending`): an account that served traffic before verification
 * existed still does, and its owner is only reminded. It never claims a link
 * arrived, since sending one can fail; it points at the inbox and offers
 * another.
 */
export function VerifyEmailBanner() {
  const { capabilities, session } = useConsoleSession();
  const send = useSendVerificationEmail();
  const user = session.user;
  if (!capabilities.emailVerification || !user || user.kind !== "human" || user.emailVerified) return null;

  const resend = async () => {
    try {
      const result = await send.mutateAsync(undefined);
      if (result.status === "already_verified") toast.success("Your email address is already verified.");
      else toast.success(`Sent a new link to ${result.email}.`);
    } catch (error) {
      toast.error(authErrorMessage(error, "Could not send the verification email"));
    }
  };

  const address = user.email ?? "your email address";
  return (
    <Alert className="mb-4">
      <MailWarning />
      <AlertTitle>
        {session.verificationPending
          ? "Verify your email address to start serving requests"
          : "Verify your email address"}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        {session.verificationPending ? (
          <span>
            Your apps answer requests with <code>email_unverified</code> until you open the
            verification link sent to {address}. Everything else works, so you can finish setting
            up meanwhile.
          </span>
        ) : (
          <span>Send yourself a verification link to confirm {address}.</span>
        )}
        <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => void resend()}>
          {send.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {session.verificationPending ? "Send a new link" : "Send a link"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
