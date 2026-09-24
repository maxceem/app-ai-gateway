import { useMemo, useReducer, useState, type ReactNode } from "react";
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
import { IdentityProviderFields } from "@/components/identity-provider-fields";
import { useDraftTransitions } from "@/hooks/use-app-draft";
import {
  draftSession,
  reduceAppDraft,
  type AppDraftAction,
  type EditorSession,
} from "@/lib/app-draft";
import { clientApiOrigin } from "@/lib/client-api";
import { authIssuer, type AuthenticationDraft, type EndUserIdentity } from "@/lib/config-types";
import { clearUnder, DRAFT_PATHS, draftIssues } from "@/lib/draft-problems";
import { matchIssuerPreset, presetInputsComplete } from "@/lib/presets";
import { newAppConfig } from "@shared/app-defaults";
import { useConsoleSession } from "@/lib/console-session";
import { cn } from "@/lib/utils";
import { useCreateApp } from "@/lib/queries";
import type { CreatedApiKey, CreatedApp } from "@/lib/types";
import { AppIdentity, SubscriptionCheck, UserAuthentication } from "@/pages/tabs/auth-policy";

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

/** What the wizard's one session is keyed by. The server assigns the real id on create. */
const NEW_APP = "new-app";

/** The team, bundle and environments an iOS application is identified by. */
type AppleIdentity = Extract<AuthenticationDraft, { type: "apple_app_attest" }>["app_attest"];

/**
 * A new application of this type, as {@link newAppConfig} builds it for the
 * console and `agw app add` alike, before any of its questions is answered
 * but the iOS identity, when one was already typed.
 */
const newConfig = (type: ApplicationType, identity?: AppleIdentity) =>
  newAppConfig(
    type === "ios"
      ? {
          type: "apple_app_attest",
          teamId: identity?.team_id ?? "",
          bundleId: identity?.bundle_id ?? "",
          environments: identity?.environments,
        }
      : { type: "api_key", endUser: { source: "none" } },
  );

/**
 * The draft the wizard opens on. No type has been chosen yet, so the
 * configuration it holds is a placeholder that choosing one replaces.
 */
const openWizard = (appId: string): EditorSession =>
  draftSession(appId, { name: "", config: newConfig("server"), status: "active" });

/** The editor's own reducer, over the session the wizard opens before its first render. */
const reduceWizard = (session: EditorSession, action: AppDraftAction): EditorSession =>
  reduceAppDraft(session, action) ?? session;

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
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [createdAppId, setCreatedAppId] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  const created = (result: CreatedApp, type: ApplicationType) => {
    setOpen(false);
    if (type === "ios") {
      toast.success(`Created ${result.app.id}`);
      navigate(`/apps/${result.app.id}/proxy`);
      return;
    }
    if (!result.api_key) {
      toast.error("The app was created without its initial API key");
      return;
    }
    setCreatedAppId(result.app.id);
    setCreatedKey(result.api_key);
    setCopied(false);
    setKeyOpen(true);
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
      <Dialog open={open} onOpenChange={setOpen}>
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
          {/* Mounted with the dialog's content, so every opening starts afresh. */}
          <NewAppSteps onCancel={() => setOpen(false)} onCreated={created} />
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
 * The wizard's steps over one draft, held in the editor's own reducer and
 * moved by the editor's own transitions: each step is the Auth policy page's
 * form for the same question, and is judged by the schema's issues under its
 * path. What the wizard adds is only which questions have been answered — a
 * type and a user source are always present in a draft, but here they are
 * choices the person has to make.
 */
function NewAppSteps({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (result: CreatedApp, type: ApplicationType) => void;
}) {
  const [session, dispatch] = useReducer(reduceWizard, NEW_APP, openWizard);
  const edit = useDraftTransitions(NEW_APP, dispatch);
  const [typeChosen, setTypeChosen] = useState(false);
  const [sourceChosen, setSourceChosen] = useState(false);
  // The iOS identity typed before the type was switched away, so switching
  // back does not ask for the team and bundle id again.
  const [appleIdentity, setAppleIdentity] = useState<AppleIdentity | undefined>(undefined);
  const [stepIndex, setStepIndex] = useState(0);
  const createApp = useCreateApp();

  const draft = session.draft;
  const authentication = draft.config.authentication;
  const issuer = authIssuer(authentication);
  const issues = useMemo(() => draftIssues(draft), [draft]);
  const applicationType: ApplicationType | null = typeChosen
    ? authentication.type === "apple_app_attest" ? "ios" : "server"
    : null;

  /*
   * The steps this application actually needs. App identity exists only for
   * an iOS app: the gateway verifies every attestation against the team and
   * bundle id and has nothing to verify without them, whereas a server app is
   * identified by its key. The identity provider and the subscription check
   * both read the sign-in token, so they appear only once sign-in is chosen.
   */
  const steps: Step[] = [STEPS.basics];
  if (applicationType === "ios") steps.push(STEPS.app_identity);
  steps.push(STEPS.users);
  if (sourceChosen && issuer) steps.push(STEPS.identity_provider, STEPS.subscription);
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const last = stepIndex >= steps.length - 1;

  // A step is judged on the schema's issues under its own path, not held back
  // by a step the person has not reached yet.
  const stepComplete = (() => {
    switch (step.id) {
      case "basics":
        return draft.name.trim().length > 0 && applicationType !== null;
      case "app_identity":
        return clearUnder(issues, DRAFT_PATHS.appAttest);
      case "users":
        return sourceChosen && clearUnder(issues, DRAFT_PATHS.header);
      case "identity_provider": {
        if (!issuer) return false;
        // The preset's own inputs are asked about too: Supabase builds URLs the
        // schema accepts even from an empty project ref.
        const { preset, values } = matchIssuerPreset(issuer);
        return presetInputsComplete(preset, values)
          && clearUnder(issues, DRAFT_PATHS.issuer, DRAFT_PATHS.claims);
      }
      case "subscription":
        return clearUnder(issues, DRAFT_PATHS.claims);
    }
  })();

  const chooseType = (next: ApplicationType) => {
    if (next === applicationType) return;
    // A new type is a new configuration. The user choices differ per type, so
    // a choice made for the other type could name a source this one cannot have.
    if (authentication.type === "apple_app_attest") setAppleIdentity(authentication.app_attest);
    edit.update({ config: newConfig(next, appleIdentity) });
    setTypeChosen(true);
    setSourceChosen(false);
  };

  const chooseSource = (source: EndUserIdentity["source"]) => {
    edit.setEndUserSource(source);
    setSourceChosen(true);
  };

  const create = async () => {
    if (!applicationType) return;
    try {
      onCreated(await createApp.mutateAsync(draft), applicationType);
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
    chooseSource(authentication.type === "apple_app_attest" ? "app_install" : "none");
    setStepIndex(steps.findIndex((entry) => entry.id === "users"));
  };

  const advance = () => {
    if (last) {
      void create();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  return (
    <>
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
                value={draft.name}
                placeholder="Calorie Tracker"
                maxLength={100}
                autoFocus
                onChange={(event) => edit.update({ name: event.target.value })}
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

        {step.id === "app_identity" && authentication.type === "apple_app_attest" ? (
          <AppIdentity authentication={authentication} state={edit} issues={issues} compact />
        ) : null}

        {step.id === "users" ? (
          <UserAuthentication
            authentication={authentication}
            state={{ ...edit, setEndUserSource: chooseSource }}
            issues={issues}
            compact
            unanswered={!sourceChosen}
          />
        ) : null}

        {step.id === "identity_provider" && issuer ? (
          <>
            <IdentityProviderFields issuer={issuer} onChange={edit.updateIssuer} />
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

        {step.id === "subscription" && issuer ? (
          <SubscriptionCheck issuer={issuer} state={edit} compact />
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
          <Button variant="outline" onClick={onCancel}>
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
