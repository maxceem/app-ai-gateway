import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="px-4">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        {/* A div: the value may be a loading skeleton, which is itself a div and cannot sit in a paragraph (Sol 7b-6). */}
        <div className="tabular mt-1.5 text-2xl leading-none font-semibold">{value}</div>
        {detail ? <p className="mt-1.5 text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
