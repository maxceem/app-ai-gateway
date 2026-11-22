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
        <p className="tabular mt-1.5 text-2xl leading-none font-semibold">{value}</p>
        {detail ? <p className="mt-1.5 text-xs text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
