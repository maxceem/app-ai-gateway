import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  Copy,
  Globe2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { PresetPicker, PresetPreview } from "@/components/preset-picker";
import { isValidAppId, slugifyAppName, uniqueAppId } from "@/lib/app-id";
import { cn } from "@/lib/utils";
import { useCreateApp } from "@/lib/queries";
import type { CreatedApiKey } from "@/lib/types";
import {
  ENTITLEMENT_PRESETS,
  ISSUER_PRESETS,
  buildEntitlement,
  buildIssuer,
  describeClaim,
  mergeClaims,
  presetInputsComplete,
  type EntitlementPreset,
  type IssuerPreset,
} from "@/lib/presets";

type ApplicationType = "ios" | "server";

const TYPE_OPTIONS: Array<{
  id: ApplicationType;
  label: string;
  description: string;
  icon: typeof Smartphone;
}> = [
  {
    id: "ios",
    label: "iOS application",
    description: "Authenticate people with an identity provider and App Attest.",
    icon: Smartphone,
  },
  {
    id: "server",
    label: "Server",
    description: "Authenticate a trusted backend with a private API key.",
    icon: Server,
  },
];

export function NewAppDialog({ existingIds }: { existingIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [customId, setCustomId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState(false);
  const [applicationType, setApplicationType] = useState<ApplicationType | null>(null);
  const [appleTeamId, setAppleTeamId] = useState("");
  const [appleBundleId, setAppleBundleId] = useState("");
  const [issuer, setIssuer] = useState<IssuerPreset>(ISSUER_PRESETS[0]!);
  const [issuerValues, setIssuerValues] = useState<Record<string, string>>({});
  const [entitlement, setEntitlement] = useState<EntitlementPreset>(ENTITLEMENT_PRESETS[0]!);
  const [entitlementValues, setEntitlementValues] = useState<Record<string, string>>({});
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [createdAppId, setCreatedAppId] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const createApp = useCreateApp();

  const existingIdKey = existingIds.join("\u0000");
  const generatedId = useMemo(
    () => (name.trim() ? uniqueAppId(name, existingIds) : ""),
    // The joined key keeps a freshly allocated prop array from regenerating a
    // random collision suffix on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, existingIdKey],
  );
  const id = customId ?? generatedId;

  const authConfig = useMemo(() => {
    const fragment = buildIssuer(issuer, issuerValues);
    const claims = mergeClaims(
      fragment.required_claims,
      buildEntitlement(entitlement, entitlementValues),
    );
    return { ...fragment, required_claims: claims };
  }, [issuer, issuerValues, entitlement, entitlementValues]);

  const idIsTaken = existingIds.includes(id);
  const idError =
    id && !isValidAppId(id)
      ? "Use lowercase letters, numbers, and hyphens (63 characters max)."
      : idIsTaken
        ? "This application ID is already in use."
        : null;
  const presetsComplete =
    presetInputsComplete(issuer, issuerValues) &&
    presetInputsComplete(entitlement, entitlementValues);
  const ready =
    name.trim().length > 0 &&
    isValidAppId(id) &&
    !idIsTaken &&
    applicationType !== null &&
    (applicationType === "server" ||
      (presetsComplete &&
        authConfig.jwks_url.startsWith("https://") &&
        appleTeamId.trim().length > 0 &&
        appleBundleId.trim().length > 0));

  const resetForm = () => {
    setName("");
    setCustomId(null);
    setEditingId(false);
    setApplicationType(null);
    setAppleTeamId("");
    setAppleBundleId("");
    setIssuer(ISSUER_PRESETS[0]!);
    setIssuerValues({});
    setEntitlement(ENTITLEMENT_PRESETS[0]!);
    setEntitlementValues({});
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) resetForm();
    setOpen(nextOpen);
  };

  const create = async () => {
    if (!applicationType) return;
    try {
      const result = await createApp.mutateAsync({
        id,
        name: name.trim(),
        config: {
          authentication:
            applicationType === "server"
              ? {
                  type: "api_key",
                  end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
                }
              : {
                  type: "apple_app_attest",
                  issuer: {
                    jwks_url: authConfig.jwks_url,
                    user_id_claim: authConfig.user_id_claim,
                    required_claims: authConfig.required_claims,
                    max_token_lifetime_seconds: 86400,
                  },
                  app_attest: {
                    team_id: appleTeamId.trim(),
                    bundle_id: appleBundleId.trim(),
                  },
                },
          routing: { providers: { mode: "all" }, model_rewrites: {} },
          limits: {
            per_user: {
              requests: { per_minute: 10, per_day: 300 },
              spending: { monthly_usd: null },
            },
            per_app: {
              requests: { per_minute: null, per_day: null },
              spending: { monthly_usd: null },
            },
          },
        },
        status: "active",
      });

      setOpen(false);
      if (applicationType === "server") {
        if (!result.api_key) throw new Error("The app was created without its initial API key");
        setCreatedAppId(result.app_id);
        setCreatedKey(result.api_key);
        setCopied(false);
        setKeyOpen(true);
        return;
      }

      toast.success(`Created ${result.app_id}`);
      navigate(`/apps/${result.app_id}/proxy`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the app");
    }
  };

  const copyKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
      toast.success("API key copied");
    } catch {
      toast.error("Could not copy the API key");
    }
  };

  const finishKeySetup = () => {
    setKeyOpen(false);
    toast.success(`Created ${createdAppId}`);
    navigate(`/apps/${createdAppId}/proxy`);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <GuardedButton size="sm">
            <Plus className="size-4" />
            New app
          </GuardedButton>
        </DialogTrigger>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-balance">Create a new application</DialogTitle>
            <DialogDescription className="text-pretty">
              Give it a name and choose where it runs. We’ll set up the right authentication.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="app-name">Application name</Label>
              <Input
                id="app-name"
                value={name}
                placeholder="Calorie Tracker"
                maxLength={100}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="app-id">Application ID</Label>
                {customId === null ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    Generated
                  </span>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Input
                  id="app-id"
                  value={id}
                  placeholder="generated-from-name"
                  readOnly={!editingId}
                  aria-invalid={idError ? true : undefined}
                  className={cn(
                    "font-mono text-sm",
                    !editingId && "bg-muted/60 text-muted-foreground",
                  )}
                  onChange={(event) => setCustomId(event.target.value.toLowerCase())}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0 active:scale-[0.96]"
                  disabled={!name.trim() && customId === null}
                  aria-label={editingId ? "Finish editing application ID" : "Edit application ID"}
                  onClick={() => {
                    if (customId === null) setCustomId(generatedId);
                    setEditingId((current) => !current);
                  }}
                >
                  {editingId ? <Check className="size-4" /> : <Pencil className="size-4" />}
                </Button>
              </div>
              <p
                className={cn(
                  "text-xs text-muted-foreground",
                  idError && "text-destructive",
                )}
                aria-live="polite"
              >
                {idError ??
                  (!name.trim()
                    ? "Generated automatically when you enter a name."
                    : slugifyAppName(name) !== id && customId === null
                    ? "A short suffix keeps this generated ID unique."
                    : "Generated from the name. Used in gateway URLs and cannot be changed later.")}
              </p>
            </div>

            <Separator />

            <fieldset className="space-y-2.5">
              <legend className="text-sm font-medium">Application type</legend>
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
                {TYPE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = applicationType === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={cn(
                        "group min-h-32 rounded-xl bg-background p-4 text-left shadow-sm ring-1 ring-border transition-[box-shadow,background-color,transform] hover:bg-muted/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96]",
                        selected && "bg-primary/[0.04] shadow-md ring-2 ring-primary",
                      )}
                      onClick={() => setApplicationType(option.id)}
                    >
                      <span
                        className={cn(
                          "mb-3 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-[background-color,color]",
                          selected && "bg-primary text-primary-foreground",
                        )}
                      >
                        <Icon className="size-5" />
                      </span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {applicationType ? (
              <div className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                  <Globe2 className="size-4.5" />
                </span>
                <div>
                  <p className="text-sm font-medium">All AI providers included</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    This application can use every provider, path, and model by default. You can
                    restrict access later from the Providers tab.
                  </p>
                </div>
              </div>
            ) : null}

            {applicationType === "ios" ? (
              <div className="space-y-5 rounded-xl bg-muted/35 p-4 shadow-inner ring-1 ring-border/70">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-muted-foreground" />
                  <p className="text-sm font-medium">iOS identity requirements</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="apple-team-id">Apple Team ID</Label>
                    <Input
                      id="apple-team-id"
                      value={appleTeamId}
                      placeholder="AAAAAAAAAA"
                      className="font-mono text-xs"
                      onChange={(event) => setAppleTeamId(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apple-bundle-id">Bundle ID</Label>
                    <Input
                      id="apple-bundle-id"
                      value={appleBundleId}
                      placeholder="com.example.app"
                      className="font-mono text-xs"
                      onChange={(event) => setAppleBundleId(event.target.value)}
                    />
                  </div>
                </div>
                <PresetPicker
                  label="Identity provider"
                  idPrefix="issuer"
                  presets={ISSUER_PRESETS}
                  selected={issuer}
                  values={issuerValues}
                  onSelect={(preset) => {
                    setIssuer(preset);
                    setIssuerValues({});
                  }}
                  onValueChange={(key, value) =>
                    setIssuerValues((current) => ({ ...current, [key]: value }))
                  }
                />

                <Separator />

                <PresetPicker
                  label="Entitlement requirement"
                  idPrefix="entitlement"
                  presets={ENTITLEMENT_PRESETS}
                  selected={entitlement}
                  values={entitlementValues}
                  onSelect={(preset) => {
                    setEntitlement(preset);
                    setEntitlementValues(
                      preset.id === "revenuecat" ? { path: "entitlements" } : {},
                    );
                  }}
                  onValueChange={(key, value) =>
                    setEntitlementValues((current) => ({ ...current, [key]: value }))
                  }
                />

                {presetsComplete ? (
                  <PresetPreview
                    fragment={{
                      jwks_url: authConfig.jwks_url,
                      claims: authConfig.required_claims.map(describeClaim),
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="active:scale-[0.96]"
              disabled={!ready || createApp.isPending}
              onClick={() => void create()}
            >
              {createApp.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Create app
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={keyOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) finishKeySetup();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-lg"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <KeyRound className="size-5" />
            </div>
            <DialogTitle className="text-balance">Your application is ready</DialogTitle>
            <DialogDescription className="text-pretty">
              We generated the first API key for{" "}
              <span className="font-mono text-foreground">{createdAppId}</span>. Copy it now—you
              won’t be able to see it again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="created-api-key">API key</Label>
            <div className="flex gap-2">
              <Input
                id="created-api-key"
                value={createdKey?.key ?? ""}
                readOnly
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                className="min-w-24 active:scale-[0.96]"
                onClick={() => void copyKey()}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Store it in your server’s secret manager. Never ship this key in a client app.
            </p>
          </div>

          <div className="rounded-lg bg-muted/50 p-3 shadow-sm ring-1 ring-border/70">
            <p className="text-sm font-medium">You can create more keys anytime</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              This key’s secret is shown only once, but you can create additional keys, review
              their usage, and revoke them from the application’s Auth policy.
            </p>
            <Link
              to={`/apps/${createdAppId}/auth`}
              className="mt-2 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
              onClick={() => setKeyOpen(false)}
            >
              Manage API keys
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>

          <DialogFooter>
            <Button className="active:scale-[0.96]" onClick={finishKeySetup}>
              I’ve saved this key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
