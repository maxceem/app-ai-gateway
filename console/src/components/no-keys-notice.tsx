import { Link } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useApiKeys } from "@/lib/queries";

/**
 * The one state that stops a server app's traffic without any other sign of
 * it: no key has been issued, or every key was revoked. Said once, above
 * whichever section is open, with the way to fix it; silent otherwise.
 */
export function NoKeysNotice({ appId }: { appId: string }) {
  const keys = useApiKeys(appId);
  if (!keys.data || keys.data.keys.some((key) => key.status === "active")) return null;

  return (
    <Alert>
      <KeyRound />
      <AlertTitle>This app has no active API key</AlertTitle>
      <AlertDescription>
        Nothing can call it until one is created.{" "}
        <Link to={`/apps/${appId}/auth/identity`} className="text-primary-ink underline underline-offset-4">
          Create an API key
        </Link>
      </AlertDescription>
    </Alert>
  );
}
