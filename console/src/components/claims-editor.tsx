import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/field";
import type { ClaimRequirement } from "@/lib/config-types";

/**
 * Every claim the token must carry, one row each. Dot paths into the issuer
 * token; `contains` matches arrays and space-delimited scopes, `equals`
 * compares exactly. The subscription presets write one of these; this edits
 * whatever is there.
 */
export function ClaimsEditor({
  claims,
  disabled = false,
  onChange,
}: {
  claims: ClaimRequirement[];
  disabled?: boolean;
  onChange: (next: ClaimRequirement[]) => void;
}) {
  const patchClaim = (index: number, partial: Partial<ClaimRequirement>) =>
    onChange(
      claims.map((claim, position) => (position === index ? { ...claim, ...partial } : claim)),
    );

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Claims the sign-in token must carry. Dot paths; contains matches arrays and
          space-delimited scopes, equals compares exactly.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onChange([...claims, { path: "", contains: "" }])}
        >
          <Plus className="size-3.5" />
          Add claim
        </Button>
      </div>
      {claims.length === 0 ? (
        <EmptyState>No claim requirements.</EmptyState>
      ) : (
        claims.map((claim, index) => {
          const mode = claim.equals !== undefined ? "equals" : "contains";
          return (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] flex-1">
                <Label className="mb-1.5 text-xs text-muted-foreground">Path</Label>
                <Input
                  value={claim.path}
                  placeholder="claims.entitlements"
                  className="font-mono text-xs"
                  disabled={disabled}
                  onChange={(event) => patchClaim(index, { path: event.target.value })}
                />
              </div>
              <div className="w-[140px]">
                <Label className="mb-1.5 text-xs text-muted-foreground">Match</Label>
                <Select
                  value={mode}
                  disabled={disabled}
                  onValueChange={(next) =>
                    onChange(
                      claims.map((item, position) =>
                        position === index
                          ? next === "equals"
                            ? {
                                path: item.path,
                                equals: Array.isArray(item.contains)
                                  ? (item.contains[0] ?? "")
                                  : (item.contains ?? ""),
                              }
                            : { path: item.path, contains: String(item.equals ?? "") }
                          : item,
                      ),
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">contains</SelectItem>
                    <SelectItem value="equals">equals</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-[180px] flex-1">
                <Label className="mb-1.5 text-xs text-muted-foreground">Value</Label>
                <Input
                  value={
                    mode === "contains" && Array.isArray(claim.contains)
                      ? claim.contains.join(", ")
                      : String(claim.equals ?? claim.contains ?? "")
                  }
                  placeholder={mode === "contains" ? "pro, pro_test" : "pro"}
                  className="font-mono text-xs"
                  disabled={disabled}
                  onChange={(event) => {
                    if (mode === "equals") {
                      patchClaim(index, { equals: event.target.value });
                      return;
                    }
                    const values = event.target.value.split(",").map((value) => value.trim());
                    patchClaim(index, {
                      contains: values.length > 1 ? values : event.target.value,
                    });
                  }}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove claim"
                disabled={disabled}
                onClick={() => onChange(claims.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
}
