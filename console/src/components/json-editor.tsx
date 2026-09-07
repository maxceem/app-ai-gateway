import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLanguage } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export function JsonEditor({
  value,
  onChange,
  readOnly,
  minHeight = "260px",
  className,
}: {
  value: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  minHeight?: string;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => [jsonLanguage(), EditorView.lineWrapping], []);
  return (
    <div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
      <CodeMirror
        value={value}
        height="auto"
        minHeight={minHeight}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        extensions={extensions}
        editable={!readOnly}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
        }}
      />
    </div>
  );
}

export interface JsonParseResult<T> {
  value: T | null;
  error: string | null;
}

export function parseJson<T>(text: string): JsonParseResult<T> {
  try {
    return { value: JSON.parse(text) as T, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}
