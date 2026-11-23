import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Said above a form whose edits were made on an older version of the app: a
 * save would be refused, because the edits were made against what it was
 * then, so the only way on is to load the latest and edit again.
 */
export function StaleDraftNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Alert>
      <AlertCircle />
      <AlertTitle>This app changed since you started editing</AlertTitle>
      <AlertDescription>
        <p>Your edits were made on an older version, so they cannot be saved. Discard them to load the latest version.</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onDiscard}>
          Discard my edits
        </Button>
      </AlertDescription>
    </Alert>
  );
}
