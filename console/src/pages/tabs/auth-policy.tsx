import { useState } from "react";
import { Copy, KeyRound, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApplyPresetDialog } from "@/components/apply-preset-dialog";
import { EmptyState, Field, SectionHeader } from "@/components/field";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  ATTEST_ENVIRONMENTS,
  type AttestEnvironment,
  type ClaimRequirement,
} from "@/lib/config-types";
import {
  useCreateDevelopmentCredential,
  useDeleteDevelopmentCredential,
  useDevelopmentCredential,
  useRotateDevelopmentCredential,
} from "@/lib/queries";
import { ServerKeys } from "@/pages/server-keys";

export function AuthPolicyTab({ appId, state }: { appId: string; state: AppDraft }) {
  const authentication = state.draft!.config.authentication;
  const credential = useDevelopmentCredential(appId, authentication.type === "apple_app_attest");
  const createCredential = useCreateDevelopmentCredential(appId);
  const rotateCredential = useRotateDevelopmentCredential(appId);
  const deleteCredential = useDeleteDevelopmentCredential(appId);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  if (authentication.type === "api_key") {
    return (
      <div className="space-y-4">
        <Alert>
          <KeyRound />
          <AlertTitle>Server tenant authentication</AlertTitle>
          <AlertDescription>
            This app accepts only long-lived server API keys. Issuer JWT and App Attest exchange
            routes are disabled.
          </AlertDescription>
        </Alert>
        <ServerKeys appId={appId} />
      </div>
    );
  }
  const auth = authentication.issuer;
  const claims = auth.required_claims ?? [];
  const environments = authentication.app_attest.environments;
  const devAccess = authentication.development_access;

  const prepareCredentialChange = async () => !state.dirty || state.save();
  const enableDevelopmentAccess = async () => {
    if (!(await prepareCredentialChange())) return;
    try {
      const created = await createCredential.mutateAsync();
      setNewSecret(created.secret);
      toast.success("Development access enabled");
    } catch (error) {
      toast.error("Could not enable development access", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
  const disableDevelopmentAccess = async () => {
    if (!(await prepareCredentialChange())) return;
    try {
      await deleteCredential.mutateAsync();
      setNewSecret(null);
      toast.success("Development access disabled");
    } catch (error) {
      toast.error("Could not disable development access", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };
  const rotateDevelopmentAccess = async () => {
    try {
      const rotated = await rotateCredential.mutateAsync();
      setNewSecret(rotated.secret);
      toast.success("Development credential rotated");
    } catch (error) {
      toast.error("Could not rotate development credential", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const setClaims = (next: ClaimRequirement[]) => state.updateIssuer({ required_claims: next });
  const patchClaim = (index: number, partial: Partial<ClaimRequirement>) =>
    setClaims(claims.map((claim, position) => (position === index ? { ...claim, ...partial } : claim)));

  const toggleEnvironment = (environment: AttestEnvironment, enabled: boolean) => {
    const next = enabled
      ? [...environments, environment]
      : environments.filter((item) => item !== environment);
    // The Worker rejects an empty list, so keep at least production selected.
    state.updateAuthentication({
      ...authentication,
      app_attest: {
        ...authentication.app_attest,
        environments: next.length > 0 ? next : ["production"],
      },
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <SectionHeader
            title="Issuer"
            description="Where the gateway fetches the keys that verify a tenant's identity tokens."
            action={<ApplyPresetDialog auth={auth} onApply={(partial) => state.updateIssuer(partial)} />}
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
              value={auth.jwks_url ?? ""}
              className="font-mono text-xs"
              placeholder="https://issuer.example.com/.well-known/jwks.json"
              onChange={(event) => state.updateIssuer({ jwks_url: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="User id claim" htmlFor="user_id_claim" hint="Defaults to sub.">
              <Input
                id="user_id_claim"
                value={auth.user_id_claim ?? ""}
                placeholder="sub"
                className="font-mono text-xs"
                onChange={(event) => state.updateIssuer({ user_id_claim: event.target.value || undefined })}
              />
            </Field>
            <Field
              label="Token header"
              htmlFor="token_header"
              hint="Optional custom header clients may use instead of Authorization."
            >
              <Input
                id="token_header"
                value={auth.token_header ?? ""}
                placeholder="authorization"
                className="font-mono text-xs"
                onChange={(event) => state.updateIssuer({ token_header: event.target.value || undefined })}
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
                value={auth.max_token_lifetime_seconds ?? ""}
                placeholder="86400"
                onChange={(event) =>
                  state.updateIssuer({
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
                                ? { path: item.path, equals: item.contains ?? "" }
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
                      value={String(claim.equals ?? claim.contains ?? "")}
                      placeholder="pro"
                      className="font-mono text-xs"
                      onChange={(event) =>
                        patchClaim(
                          index,
                          mode === "equals"
                            ? { equals: event.target.value }
                            : { contains: event.target.value },
                        )
                      }
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">App Attest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Which Apple-signed environments may register keys. Include development only while
            Debug-provisioned device builds need it.
          </p>
          <div className="flex flex-wrap gap-4">
            {ATTEST_ENVIRONMENTS.map((environment) => (
              <label key={environment} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={environments.includes(environment)}
                  onCheckedChange={(checked) => toggleEnvironment(environment, checked === true)}
                />
                {environment}
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <SectionHeader
            title="Simulator development access"
            description="Lets Simulator clients exchange a valid issuer token plus this app's secret. Identity still comes from the issuer token."
            action={
              <Switch
                checked={devAccess}
                disabled={createCredential.isPending || deleteCredential.isPending || credential.isLoading}
                onCheckedChange={(checked) => void (checked
                  ? enableDevelopmentAccess()
                  : disableDevelopmentAccess())}
              />
            }
          />
        </CardHeader>
        {devAccess ? (
          <CardContent className="space-y-4">
            {newSecret ? (
              <Alert>
                <KeyRound />
                <AlertTitle>Copy this credential now</AlertTitle>
                <AlertDescription>
                  <div className="mt-2 flex gap-2">
                    <Input readOnly value={newSecret} className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Copy development credential"
                      onClick={() => void navigator.clipboard.writeText(newSecret)}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                  <p className="mt-2">It is stored as a hash and cannot be shown again.</p>
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">Stored credential</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {credential.data?.secret_prefix ?? "Credential"}…
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={rotateCredential.isPending}
                onClick={() => void rotateDevelopmentAccess()}
              >
                <RefreshCw className="size-3.5" />
                Rotate
              </Button>
            </div>
            <Alert>
              <TriangleAlert />
              <AlertTitle>Production apps should disable this</AlertTitle>
              <AlertDescription>
                Anyone holding this secret and any valid issuer token can reach the proxy from a
                Simulator build.
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
