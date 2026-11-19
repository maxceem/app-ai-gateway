import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/field";
import { providerLabel } from "@/lib/providers";
import { usePrices } from "@/lib/queries";
import type { PriceList } from "@/lib/types";

export interface PriceRow {
  type: string;
  model: string;
  kind: string | null;
  input: number | null;
  output: number | null;
  unlistedSince: string | null;
  retirementDate: string | null;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The price file as rows, one per model, sorted by provider and model. */
export function priceRows(prices: PriceList): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const [type, models] of Object.entries(prices)) {
    for (const [model, entry] of Object.entries(models)) {
      rows.push({
        type,
        model,
        kind: textOrNull(entry.kind),
        input: numberOrNull(entry.input),
        output: numberOrNull(entry.output),
        unlistedSince: textOrNull(entry.unlisted_since),
        retirementDate: textOrNull(entry.retirement_date),
      });
    }
  }
  return rows.sort((a, b) => a.type.localeCompare(b.type) || a.model.localeCompare(b.model));
}

const rate = (value: number | null) => (value === null ? "—" : `$${value}`);

/**
 * The prices this gateway bills with, per million units, as the price file
 * has them. A model with no price here is refused when an app names it.
 */
export function PricesPage() {
  const prices = usePrices();
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => (prices.data ? priceRows(prices.data.prices) : []), [prices.data]);
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((row) => row.model.toLowerCase().includes(needle) || row.type.toLowerCase().includes(needle))
    : rows;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prices"
        description="What each model costs, in dollars per million units: tokens for text models, and the model's own unit for the rest."
        action={
          <Input
            aria-label="Filter models"
            placeholder="Filter models"
            className="h-8 w-56"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        }
      />

      {prices.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load prices</AlertTitle>
          <AlertDescription>{prices.error instanceof Error ? prices.error.message : "Unknown error"}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.isPending ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ) : shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  No models match.
                </TableCell>
              </TableRow>
            ) : (
              shown.map((row) => (
                <TableRow key={`${row.type}/${row.model}`}>
                  <TableCell>{providerLabel(row.type)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.model}</TableCell>
                  <TableCell className="text-muted-foreground">{row.kind ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{rate(row.input)}</TableCell>
                  <TableCell className="text-right tabular-nums">{rate(row.output)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[
                      row.unlistedSince ? `Unlisted since ${row.unlistedSince}` : null,
                      row.retirementDate ? `Retires ${row.retirementDate}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
