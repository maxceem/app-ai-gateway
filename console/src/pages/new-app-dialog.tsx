import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check, Copy, Loader2, Plus, Server, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GuardedButton } from "@/components/guarded-button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppAttestEnvironments } from "@/components/app-attest-environments";
import { ChoiceList } from "@/components/choice-list";
import { ExternalHint } from "@/components/external-hint";
import { PresetPicker } from "@/components/preset-picker";
import { clientApiOrigin } from "@/lib/client-api";
import {
  DEFAULT_END_USER_HEADER,
  type AppAttestEnvironment,
  type AuthenticationConfig,
} from "@/lib/config-types";
import { useConsoleSession } from "@/lib/console-session";
import { cn } from "@/lib/utils";
import { useCreateApp } from "@/lib/queries";
import type { CreatedApiKey } from "@/lib/types";
import { IOS_USER_CHOICES, SERVER_USER_CHOICES, type UserSource } from "@/lib/user-sources";
import {
  ENTITLEMENT_FIELD_LABEL,
  ENTITLEMENT_PRESETS,
  ISSUER_PRESETS,
  buildEntitlement,
  buildIssuer,
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
    description: "Calls AI providers straight from the app.",
    icon: Smartphone,
  },
  {
    id: "server",
    label: "Server",
    description: "A backend you run, using a private API key.",
    icon: Server,
  },
];

type StepId = "basics" | "app_identity" | "users" | "identity_provider" | "subscription";

interface Step {
  id: StepId;
  /** Read out for the footer dot. */
  label: string;
  /** The question this step answers, when the title alone does not say it. */
  subtitle?: string;
  text?: string;
}

const STEPS: Record<StepId, Step> = {
  basics: { id: "basics", label: "Basics" },
  app_identity: {
    id: "app_identity",
    label: "Application identity",
    subtitle: "Application identity",
    text: "Set your app's identity so that only this app can call AI providers through this gateway.",
  },
  users: {
    id: "users",
    label: "User authentication",
    subtitle: "User authentication",
    text: "Choose whether only users signed in to your app can call AI through this gateway.",
  },
  identity_provider: {
    id: "identity_provider",
    label: "Identity provider",
    subtitle: "Identity provider",
    text: "Where your users sign in. The gateway verifies their sign-in tokens against it.",
  },
  subscription: {
    id: "subscription",
    label: "Subscription check",
    subtitle: "Subscription check",
    text: "Check that the user has paid for the app before they can call AI providers through this gateway.",
  },
};

const ENTITLEMENT_NONE = ENTITLEMENT_PRESETS.find((preset) => preset.id === "none")!;

/**
 * `trigger` replaces the default "New app" button for callers that open the
 * same wizard from somewhere the button would read wrong — the first-run card
 * on the apps page, where it is one numbered step among three. It must still
 * be a {@link GuardedButton}: the guard is what tells a read-only member why
 * nothing happens, and a bare element would simply fail on submit instead.
 */
export function NewAppDialog({ trigger }: { trigger?: ReactNode } = {}) {
  const { capabilities } = useConsoleSession();
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState("");
  const [applicationType, setApplicationType] = useState<ApplicationType | null>(null);
  const [appleTeamId, setAppleTeamId] = useState("");
  const [appleBundleId, setAppleBundleId] = useState("");
  const [environments, setEnvironments] = useState<AppAttestEnvironment[] | undefined>(undefined);
  const [userSource, setUserSource] = useState<UserSource | null>(null);
  const [issuer, setIssuer] = useState<IssuerPreset>(ISSUER_PRESETS[0]!);
  const [issuerValues, setIssuerValues] = useState<Record<string, string>>({});
  const [entitlement, setEntitlement] = useState<EntitlementPreset>(ENTITLEMENT_NONE);
  const [entitlementValues, setEntitlementValues] = useState<Record<string, string>>({});
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [createdAppId, setCreatedAppId] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const createApp = useCreateApp();

  /*
   * The steps this application actually needs. App identity exists only for
   * an iOS app: the gateway verifies every attestation against the team and
   * bundle id and has nothing to verify without them, whereas a server app is
   * identified by its key. The identity provider and the subscription check
   * both read the sign-in token, so they appear only once sign-in is chosen.
   */
  const steps = useMemo<Step[]>(() => {
    const list = [STEPS.basics];
    if (applicationType === "ios") list.push(STEPS.app_identity);
    list.push(STEPS.users);
    if (userSource === "issuer") list.push(STEPS.identity_provider, STEPS.subscription);
    return list;
  }, [applicationType, userSource]);
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const last = stepIndex >= steps.length - 1;

  const issuerFragment = useMemo(() => buildIssuer(issuer, issuerValues), [issuer, issuerValues]);
  const issuerComplete =
    presetInputsComplete(issuer, issuerValues) &&
    issuerFragment.jwks_url.startsWith("https://") &&
    // Both scope the app to one tenant, and the Worker refuses a write without
    // them, so the dialog cannot offer to create one either.
    issuerFragment.issuer.length > 0 &&
    issuerFragment.audience.length > 0;

  const stepComplete = (() => {
    switch (step.id) {
      case "basics":
        return name.trim().length > 0 && applicationType !== null;
      case "app_identity":
        return appleTeamId.trim().length > 0 && appleBundleId.trim().length > 0;
      case "users":
        return userSource !== null;
      case "identity_provider":
        return issuerComplete;
      case "subscription":
        return presetInputsComplete(entitlement, entitlementValues);
    }
  })();

  const resetForm = () => {
    setStepIndex(0);
    setName("");
    setApplicationType(null);
    setAppleTeamId("");
    setAppleBundleId("");
    setEnvironments(undefined);
    setUserSource(null);
    setIssuer(ISSUER_PRESETS[0]!);
    setIssuerValues({});
    setEntitlement(ENTITLEMENT_NONE);
    setEntitlementValues({});
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) resetForm();
    setOpen(nextOpen);
  };

  const chooseType = (next: ApplicationType) => {
    if (next === applicationType) return;
    setApplicationType(next);
    // The user choices differ per type, so a choice made for the other type
    // could name a source this one cannot have.
    setUserSource(null);
  };

  const authentication = (): AuthenticationConfig => {
    const signIn = userSource === "issuer"
      ? {
          source: "issuer" as const,
          issuer: {
            provider: issuer.id,
            jwks_url: issuerFragment.jwks_url,
            issuer: issuerFragment.issuer,
            audience: issuerFragment.audience,
            user_id_claim: issuerFragment.user_id_claim,
            required_claims: buildEntitlement(entitlement, entitlementValues),
            max_token_lifetime_seconds: 86400,
            // Named so the Auth policy page can reopen the same form, and
            // absent rather than "none" when there is no check to reopen.
            ...(entitlement.id === "none" ? {} : { entitlement: entitlement.id }),
          },
        }
      : null;

    if (applicationType === "ios") {
      return {
        type: "apple_app_attest",
        app_attest: {
          team_id: appleTeamId.trim(),
          bundle_id: appleBundleId.trim(),
          // Production only is the gateway's own default, so it is not written.
          ...(environments?.includes("development") ? { environments } : {}),
        },
        end_user: signIn ?? { source: "app_install" },
      };
    }
    if (signIn) return { type: "api_key", end_user: signIn };
    if (userSource === "header") {
      return { type: "api_key", end_user: { source: "header", header: DEFAULT_END_USER_HEADER } };
    }
    return { type: "api_key" };
  };

  const create = async () => {
    if (!applicationType) return;
    try {
      const result = await createApp.mutateAsync({
        name: name.trim(),
        config: {
          authentication: authentication(),
          routing: { providers: { mode: "all" }, model_rewrites: {} },
          /*
           * A mobile app ships its credential inside the client, where every
           * install is a stranger, so it starts rate limited rather than open.
           * Both of its sources tell installs apart, so the limit always has
           * someone to apply to.
           *
           * A server app gets no default at all. Even when it names its users,
           * the requests come from one backend the operator controls, and a
           * ten-a-minute cap silently applied there would throttle it.
           */
          ...(applicationType === "server" ? {} : {
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
          }),
        },
        status: "active",
      });

      setOpen(false);
      if (applicationType === "server") {
        if (!result.api_key) throw new Error("The app was created without its initial API key");
        setCreatedAppId(result.app.id);
        setCreatedKey(result.api_key);
        setCopied(false);
        setKeyOpen(true);
        return;
      }

      toast.success(`Created ${result.app.id}`);
      navigate(`/apps/${result.app.id}/proxy`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the app");
    }
  };

  /*
   * Someone who chose sign-in and then finds they do not have the provider's
   * details should not be stuck. This changes the answer to the one that needs
   * nothing and returns to the question, so the new answer is seen before the
   * app is created rather than applied silently.
   */
  const deferSignIn = () => {
    setUserSource(applicationType === "ios" ? "app_install" : "none");
    setStepIndex(steps.findIndex((entry) => entry.id === "users"));
  };

  const advance = () => {
    if (last) {
      void create();
      return;
    }
    setStepIndex((current) => current + 1);
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
          {trigger ?? (
            <GuardedButton size="sm">
              <Plus className="size-4" />
              New app
            </GuardedButton>
          )}
        </DialogTrigger>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create a new application</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-6">
            {step.subtitle ? (
              <div className="space-y-1.5">
                <h3 className="text-base font-semibold">{step.subtitle}</h3>
                {step.text ? (
                  <p className="text-sm text-pretty text-muted-foreground">{step.text}</p>
                ) : null}
              </div>
            ) : null}

            {step.id === "basics" ? (
              <>
                <div className="space-y-2.5">
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

                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium">Application type</legend>
                  <div className="grid gap-4 sm:grid-cols-2" role="radiogroup">
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
                            "group min-h-32 rounded-xl bg-background p-5 text-left shadow-sm ring-1 ring-border transition-[box-shadow,background-color] hover:bg-muted/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected && "bg-primary/[0.04] shadow-md ring-2 ring-primary",
                          )}
                          onClick={() => chooseType(option.id)}
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
              </>
            ) : null}

            {step.id === "app_identity" ? (
              <div className="space-y-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2.5">
                    <Label htmlFor="apple-team-id">Apple Team ID</Label>
                    <Input
                      id="apple-team-id"
                      value={appleTeamId}
                      placeholder="ABCDE12345"
                      className="font-mono text-xs"
                      autoFocus
                      onChange={(event) => setAppleTeamId(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      In your Apple Developer account under{" "}
                      <ExternalHint href="https://developer.apple.com/account#MembershipDetailsCard">
                        Membership details
                      </ExternalHint>
                      .
                    </p>
                  </div>
                  <div className="space-y-2.5">
                    <Label htmlFor="apple-bundle-id">Bundle ID</Label>
                    <Input
                      id="apple-bundle-id"
                      value={appleBundleId}
                      placeholder="com.example.calorietracker"
                      className="font-mono text-xs"
                      onChange={(event) => setAppleBundleId(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      In Xcode, on your target&apos;s{" "}
                      <ExternalHint href="https://developer.apple.com/documentation/xcode/configuring-the-build-settings-of-a-target#Set-the-bundle-ID">
                        Signing &amp; Capabilities
                      </ExternalHint>{" "}
                      tab.
                    </p>
                  </div>
                </div>
                <AppAttestEnvironments value={environments} onChange={setEnvironments} compact />
              </div>
            ) : null}

            {step.id === "users" ? (
              <ChoiceList
                label="User authentication"
                choices={applicationType === "ios" ? IOS_USER_CHOICES : SERVER_USER_CHOICES}
                value={userSource}
                onChange={setUserSource}
              />
            ) : null}

            {step.id === "identity_provider" ? (
              <>
                <PresetPicker
                  idPrefix="issuer"
                  label="Identity provider"
                  presets={ISSUER_PRESETS}
                  selected={issuer}
                  values={issuerValues}
                  compact
                  onSelect={(preset) => {
                    setIssuer(preset);
                    setIssuerValues({});
                  }}
                  onValueChange={(key, value) =>
                    setIssuerValues((current) => ({ ...current, [key]: value }))
                  }
                />
                <p className="text-sm text-muted-foreground">
                  Don&apos;t have these details yet?{" "}
                  <button
                    type="button"
                    className="font-medium text-primary-ink underline decoration-primary-ink/40 underline-offset-4 transition-colors hover:decoration-primary-ink"
                    onClick={deferSignIn}
                  >
                    {applicationType === "ios"
                      ? "Allow unauthenticated users for now"
                      : "Continue without user identity for now"}
                  </button>{" "}
                  and set this up later.
                </p>
              </>
            ) : null}

            {step.id === "subscription" ? (
              <PresetPicker
                idPrefix="entitlement"
                label={ENTITLEMENT_FIELD_LABEL}
                presets={ENTITLEMENT_PRESETS}
                selected={entitlement}
                values={entitlementValues}
                compact
                onSelect={(preset) => {
                  setEntitlement(preset);
                  setEntitlementValues({});
                }}
                onValueChange={(key, value) =>
                  setEntitlementValues((current) => ({ ...current, [key]: value }))
                }
              />
            ) : null}
          </DialogBody>

          <DialogFooter className="items-center sm:justify-between">
            {stepIndex > 0 ? (
              <Button
                variant="ghost"
                onClick={() => setStepIndex((current) => current - 1)}
                disabled={createApp.isPending}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
            <StepDots steps={steps} current={stepIndex} onSelect={setStepIndex} />
            <Button
              disabled={!stepComplete || createApp.isPending}
              onClick={advance}
            >
              {createApp.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {last ? "Create app" : "Next"}
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
        >
          <DialogHeader>
            <DialogTitle className="text-balance">Your application is ready</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-5">
            <DialogDescription className="text-pretty">
              This is the API key for{" "}
              <span className="font-mono text-foreground">{createdAppId}</span>. It is shown only
              once, so copy it now.
            </DialogDescription>
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
                  className="min-w-24"
                  onClick={() => void copyKey()}
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Base URL</p>
              <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-muted-foreground">
                {clientApiOrigin(capabilities)}/v1/apps/
                <span className="text-foreground">{createdAppId}</span>
                /proxy/&#123;provider&#125;/&#123;provider_path&#125;
              </code>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button onClick={finishKeySetup}>
              I’ve saved this key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Where the person is. Dots for the steps passed are buttons, so an earlier
 * answer can be revisited without stepping back through everything between;
 * the ones ahead are not, because reaching a step means finishing the ones
 * before it.
 */
function StepDots({
  steps,
  current,
  onSelect,
}: {
  steps: Step[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex items-center gap-2" aria-label="Steps">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const dot = (
          <span
            className={cn(
              "block size-2 rounded-full transition-colors",
              active ? "bg-primary" : done ? "bg-primary/40" : "bg-border",
            )}
          />
        );
        return (
          <li key={step.id} aria-current={active ? "step" : undefined}>
            {done ? (
              <button
                type="button"
                aria-label={`Back to ${step.label}`}
                className="flex size-5 items-center justify-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(index)}
              >
                {dot}
              </button>
            ) : (
              <span
                className="flex size-5 items-center justify-center"
                aria-label={`${step.label}${active ? ", current step" : ""}`}
              >
                {dot}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
