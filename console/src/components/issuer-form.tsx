import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApplyPresetDialog } from "@/components/apply-preset-dialog";
import { EmptyState, Field, SectionHeader } from "@/components/field";
import type { AuthConfig, ClaimRequirement } from "@/lib/config-types";

/**
 * The issuer policy form, shared by App Attest apps — where an issuer is
 * mandatory — and api_key apps that opted into verified user identity. Both
 * store the identical block, so both edit it through the same fields.
 */
export function IssuerCards({
  issuer,
  onChange,
}: {
  issuer: AuthConfig;
  onChange: (partial: Partial<AuthConfig>) => void;
}) {
  const claims = issuer.required_claims ?? [];
  const setClaims = (next: ClaimRequirement[]) => onChange({ required_claims: next });
  const patchClaim = (index: number, partial: Partial<ClaimRequirement>) =>
    setClaims(claims.map((claim, position) => (position === index ? { ...claim, ...partial } : claim)));

  return (
    <>
      <Card>
        <CardHeader>
          <SectionHeader
            title="Issuer"
            description="Where the gateway fetches the keys that verify a tenant's identity tokens."
            action={<ApplyPresetDialog auth={issuer} onApply={onChange} />}
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="JWKS URL"
            htmlFor="jwks_url"
            hint="Must be HTTPS. The gateway always verifies signature, exp, iat, the lifetime cap, and a non-empty user id."
          >
            <Input
              id="jwks_url"
              value={issuer.jwks_url ?? ""}
              className="font-mono text-xs"
              placeholder="https://issuer.example.com/.well-known/jwks.json"
              onChange={(event) => onChange({ jwks_url: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="User id claim" htmlFor="user_id_claim" hint="Defaults to sub.">
              <Input
                id="user_id_claim"
                value={issuer.user_id_claim ?? ""}
                placeholder="sub"
                className="font-mono text-xs"
                onChange={(event) => onChange({ user_id_claim: event.target.value || undefined })}
              />
            </Field>
            <Field
              label="Token header"
              htmlFor="token_header"
              hint="Optional custom header clients may use instead of Authorization."
            >
              <Input
                id="token_header"
                value={issuer.token_header ?? ""}
                placeholder="authorization"
                className="font-mono text-xs"
                onChange={(event) => onChange({ token_header: event.target.value || undefined })}
              />
            </Field>
            <Field
              label="Max issuer token lifetime"
              htmlFor="lifetime"
              hint="Seconds. Rejects issuer tokens minted with a longer life. Defaults to 86400."
            >
              <Input
                id="lifetime"
                type="number"
                min={1}
                value={issuer.max_token_lifetime_seconds ?? ""}
                placeholder="86400"
                onChange={(event) =>
                  onChange({
                    max_token_lifetime_seconds: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  })
                }
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionHeader
            title="Required claims"
            description="Dot paths into the issuer token. contains matches arrays and space-delimited scopes; equals compares exactly."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => setClaims([...claims, { path: "", contains: "" }])}
              >
                <Plus className="size-3.5" />
                Add claim
              </Button>
            }
          />
        </CardHeader>
        <CardContent className="space-y-3">
          {claims.length === 0 ? (
            <EmptyState>
              No claim requirements. Any user the issuer signs a token for can reach this app.
            </EmptyState>
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
                      onChange={(event) => patchClaim(index, { path: event.target.value })}
                    />
                  </div>
                  <div className="w-[140px]">
                    <Label className="mb-1.5 text-xs text-muted-foreground">Match</Label>
                    <Select
                      value={mode}
                      onValueChange={(next) =>
                        setClaims(
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
                    onClick={() => setClaims(claims.filter((_, position) => position !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </>
  );
}
