import { useState } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/field";
import { PageAction } from "@/components/page-action";
import type { AppDraft } from "@/hooks/use-app-draft";

/** One editable line of the rewrite list, which a half-typed row can also be. */
type RewriteRow = [source: string, target: string];

/** The rows a rewrite map can actually hold: both sides filled in. */
const completeRewrites = (rows: RewriteRow[]) =>
  rows.filter(([source, target]) => source !== "" && target !== "");

const asRewriteMap = (rows: RewriteRow[]) => Object.fromEntries(completeRewrites(rows));

/**
 * The rewrite editor, one row per remap.
 *
 * Rows are held here rather than in the draft because the draft stores a map,
 * and a row being typed is not yet a map entry: it has no key until a source is
 * given, and the Worker refuses an entry whose target is empty. Committing rows
 * straight to the map would drop a new blank row on the way in, so the map
 * would not change and no row would appear. Only complete rows are committed,
 * and the incomplete one stays on screen until it is finished.
 */
export function ModelRewritesTab({ state }: { state: AppDraft }) {
  const rewrites = state.draft!.config.routing.model_rewrites;
  const onChange = (model_rewrites: Record<string, string>) => state.updateProxy({ model_rewrites });

  const [rows, setRows] = useState<RewriteRow[]>(() => Object.entries(rewrites));

  /*
   * The draft can also change from outside this page: another app is opened, or
   * the edits are discarded. Rebuild the rows when that happens, but not when
   * the map is merely echoing back what these rows just committed — that would
   * take away the row currently being filled in. Comparing the incoming map
   * against a snapshot keeps the check to once per actual change.
   */
  const incoming = JSON.stringify(rewrites);
  const [synced, setSynced] = useState(incoming);
  if (incoming !== synced) {
    setSynced(incoming);
    if (incoming !== JSON.stringify(asRewriteMap(rows))) setRows(Object.entries(rewrites));
  }

  const update = (next: RewriteRow[]) => {
    setRows(next);
    onChange(asRewriteMap(next));
  };

  const editRow = (index: number, row: RewriteRow) =>
    update(rows.map((entry, position) => (position === index ? row : entry)));

  const incomplete = completeRewrites(rows).length < rows.length;

  return (
    <Card>
      <PageAction>
        <Button size="sm" onClick={() => update([...rows, ["", ""]])}>
          <Plus className="size-4" />
          Add rewrite
        </Button>
      </PageAction>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <EmptyState>No rewrites. Clients get exactly the model they ask for.</EmptyState>
        ) : (
          rows.map(([source, target], index) => (
            <div key={index} className="flex items-center gap-2">
              {/*
                Both sides carry flex-1 so the row splits evenly. The Input
                primitive is w-full, which as a direct flex child resolves to a
                full-width basis and takes the whole row — leaving a basis-0
                sibling nothing to shrink into.
              */}
              <Input
                value={source}
                aria-label={`Rewrite ${index + 1} source model`}
                placeholder="gpt-5.6-terra"
                className="flex-1 font-mono text-xs"
                onChange={(event) => editRow(index, [event.target.value, target])}
              />
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={target}
                aria-label={`Rewrite ${index + 1} target model`}
                placeholder="gpt-5.7"
                className="flex-1 font-mono text-xs"
                onChange={(event) => editRow(index, [source, event.target.value])}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove rewrite ${index + 1}`}
                onClick={() => update(rows.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))
        )}
        {incomplete ? (
          <p className="pt-1 text-xs text-muted-foreground">
            A row is saved once both sides are filled in.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
