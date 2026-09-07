import { useEffect, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SectionHeader } from "@/components/field";
import { JsonEditor, parseJson } from "@/components/json-editor";
import type { AppDraft, Draft } from "@/hooks/use-app-draft";

/**
 * The escape hatch: anything the typed forms do not cover yet is still editable
 * here, against the same draft the forms and the save button use.
 */
export function RawJsonTab({ state }: { state: AppDraft }) {
  const draft = state.draft!;
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
  const [editing, setEditing] = useState(false);

  // Follow the draft while the forms own it; stop once this editor is the source.
  useEffect(() => {
    if (!editing) setText(JSON.stringify(draft, null, 2));
  }, [draft, editing]);

  const onChange = (next: string) => {
    setEditing(true);
    setText(next);
    const parsed = parseJson<Draft>(next);
    if (parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      state.setDraft(parsed.value);
    }
  };

  const error = parseJson<Draft>(text).error;

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title="App row"
          description="Exactly the body POST /v1/admin/apps/{app} accepts. Edits flow into the same unsaved draft as the forms."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(false);
                setText(JSON.stringify(draft, null, 2));
              }}
            >
              <RotateCcw className="size-3.5" />
              Reformat
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Invalid JSON</AlertTitle>
            <AlertDescription>{error}. The draft keeps the last valid value.</AlertDescription>
          </Alert>
        ) : null}
        <JsonEditor value={text} onChange={onChange} minHeight="420px" />
        <p className="text-xs text-muted-foreground">
          API keys are managed separately and never appear in this JSON.
        </p>
      </CardContent>
    </Card>
  );
}
