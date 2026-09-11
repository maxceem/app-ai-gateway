import { useId, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { CircleAlert, CircleCheck, CircleDashed, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppAttestEnvironments } from "@/components/app-attest-environments";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { ExternalHint } from "@/components/external-hint";
import { Field, SectionHeader } from "@/components/field";
import { DisabledReason } from "@/components/guarded-button";
import { IdentityProviderFields } from "@/components/identity-provider-fields";
import { DEFAULT_PAID_CLAIM, SubscriptionFields } from "@/components/subscription-fields";
import type { AppDraft, Draft } from "@/hooks/use-app-draft";
import {
  DEFAULT_END_USER_HEADER,
  authIssuer,
  emptyIssuer,
  type AuthConfig,
  type AuthenticationConfig,
} from "@/lib/config-types";
import { useConsoleSession } from "@/lib/console-session";
import { claimComplete, issuerComplete } from "@/lib/draft-problems";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useApiKeys } from "@/lib/queries";
import { IOS_USER_CHOICES, SERVER_USER_CHOICES, type UserSource } from "@/lib/user-sources";
import { cn } from "@/lib/utils";
import { ServerKeys } from "@/pages/server-keys";

export type AuthLevel = "identity" | "users" | "subscription";

export const DEFAULT_AUTH_LEVEL: AuthLevel = "identity";

const LEVELS: { slug: AuthLevel; label: string }[] = [
  { slug: "identity", label: "Application identity" },
  { slug: "users", label: "User authentication" },
  { slug: "subscription", label: "Subscription check" },
];

/**
 * How a level stands, read off the draft. `secure` is the strictest answer
 * the level offers; `weak` is a deliberate looser one; `incomplete` means the
 * answer given still lacks something the gateway needs; `off` means the level
 * does not apply until a level above changes.
 */
interface LevelStatus {
  tone: "secure" | "weak" | "incomplete" | "off";
  text: string;
}

const STATUS_ICONS: Record<LevelStatus["tone"], { icon: ComponentType<{ className?: string }>; className: string }> = {
  secure: { icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400" },
  weak: { icon: ShieldAlert, className: "text-amber-600 dark:text-amber-400" },
  incomplete: { icon: CircleAlert, className: "text-destructive" },
  off: { icon: CircleDashed, className: "text-muted-foreground/60" },
};

type Subscription = "paid" | "any";

const SUBSCRIPTION_CHOICES: Choice<Subscription>[] = [
  {
    value: "paid",
    label: "Paid users only",
    description: "The sign-in token must carry a claim that says the user has paid.",
  },
  {
    value: "any",
    label: "Any signed-in user",
    description: "Signing in is enough. Nothing about payment is checked.",
  },
];

const subscriptionOf = (issuer: AuthConfig): Subscription =>
  (issuer.required_claims ?? []).length > 0 || issuer.entitlement !== undefined ? "paid" : "any";

/**
 * Each level's standing, in the order the levels are asked. `keysActive` is
 * what the key list says for a server app, or undefined while unknown.
 */
export function levelStatuses(
  draft: Draft,
  keysActive: boolean | undefined,
): Record<AuthLevel, LevelStatus> {
  const authentication = draft.config.authentication;
  const issuer = authIssuer(authentication);

  const identity: LevelStatus =
    authentication.type === "apple_app_attest"
      ? !authentication.app_attest.team_id.trim() || !authentication.app_attest.bundle_id.trim()
        ? { tone: "incomplete", text: "Team or bundle id missing" }
        : { tone: "secure", text: "Verified with App Attest" }
      : keysActive === false
        ? { tone: "incomplete", text: "No active API key" }
        : { tone: "secure", text: "Verified with API keys" };

  const users: LevelStatus = (() => {
    const source: UserSource = authentication.end_user?.source ?? "none";
    switch (source) {
      case "issuer":
        return issuer && issuerComplete(issuer)
          ? { tone: "secure", text: "Signed-in users only" }
          : { tone: "incomplete", text: "Identity provider not finished" };
      case "header":
        return authentication.type === "api_key" && authentication.end_user?.source === "header"
          && !authentication.end_user.header.trim()
          ? { tone: "incomplete", text: "Header name missing" }
          : { tone: "weak", text: "Your backend names the user" };
      case "app_install":
        return { tone: "weak", text: "Unauthenticated users allowed" };
      default:
        return { tone: "weak", text: "No user identity" };
    }
  })();

  const subscription: LevelStatus = !issuer
    ? { tone: "off", text: "Needs signed-in users" }
    : subscriptionOf(issuer) === "paid"
      ? (issuer.required_claims ?? []).every(claimComplete) && (issuer.required_claims ?? []).length > 0
        ? { tone: "secure", text: "Paid users only" }
        : { tone: "incomplete", text: "Paid check not finished" }
      : { tone: "weak", text: "Any signed-in user" };

  return { identity, users, subscription };
}

/**
 * Who may call this app, as the ladder of decisions the creation wizard asked:
 * how the app proves itself, then whether its users must be signed in, then,
 * for signed-in users only, whether they must have paid. Each level is a page
 * of its own; the list on the left says where every level stands, so the
 * whole policy is readable without opening any of them.
 */
export function AuthPolicyTab({
  appId,
  level,
  state,
}: {
  appId: string;
  level: string | undefined;
  state: AppDraft;
}) {
  const draft = state.draft!;
  const authentication = draft.config.authentication;
  const { readOnly } = useConsoleSession();
  const isServer = authentication.type === "api_key";
  const keys = useApiKeys(appId, isServer);
  const keysActive = keys.data ? keys.data.keys.some((key) => key.status === "active") : undefined;
  const statuses = levelStatuses(draft, keysActive);
  const current: AuthLevel =
    LEVELS.some((entry) => entry.slug === level) && statuses[level as AuthLevel].tone !== "off"
      ? (level as AuthLevel)
      : DEFAULT_AUTH_LEVEL;

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav aria-label="Auth policy levels" className="flex flex-col gap-1 lg:sticky lg:top-6 lg:self-start">
        {LEVELS.map((entry) => (
          <LevelRow
            key={entry.slug}
            to={`/apps/${appId}/auth/${entry.slug}`}
            label={entry.label}
            status={statuses[entry.slug]}
            current={entry.slug === current}
          />
        ))}
      </nav>

      <div className="min-w-0 space-y-4">
        {current === "identity" ? (
          authentication.type === "apple_app_attest" ? (
            <AppIdentity authentication={authentication} readOnly={readOnly} state={state} />
          ) : (
            <ServerKeys
              appId={appId}
              exchanged={authIssuer(authentication) !== undefined}
              title="Application identity"
              description="A server application. Your backend proves itself with one of these API keys."
            />
          )
        ) : current === "users" ? (
          <UserAuthentication authentication={authentication} readOnly={readOnly} state={state} />
        ) : (
          <SubscriptionCheck
            issuer={authIssuer(authentication) ?? emptyIssuer()}
            readOnly={readOnly}
            state={state}
          />
        )}
      </div>
    </div>
  );
}

/** One level in the list: where to go, and how it stands. */
function LevelRow({
  to,
  label,
  status,
  current,
}: {
  to: string;
  label: string;
  status: LevelStatus;
  current: boolean;
}) {
  const { icon: Icon, className } = STATUS_ICONS[status.tone];
  const body = (
    <>
      <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{status.text}</span>
      </span>
    </>
  );
  const rowClass = "flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors";

  if (status.tone === "off") {
    // Not a place to go yet: the level above has to change first.
    return (
      <div aria-disabled="true" className={cn(rowClass, "opacity-60")}>
        {body}
      </div>
    );
  }
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={cn(
        rowClass,
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        current ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      {body}
    </Link>
  );
}

/** How an iOS app proves it is this app: the team and bundle Apple attests. */
function AppIdentity({
  authentication,
  readOnly,
  state,
}: {
  authentication: Extract<AuthenticationConfig, { type: "apple_app_attest" }>;
  readOnly: boolean;
  state: AppDraft;
}) {
  const attest = authentication.app_attest;
  const patch = (partial: Partial<typeof attest>) =>
    state.updateAuthentication({ ...authentication, app_attest: { ...attest, ...partial } });

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title="Application identity"
          description="An iOS application. Only builds signed with this team and bundle id can call AI providers through this gateway."
        />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2.5">
            <Label htmlFor="apple-team-id">Apple Team ID</Label>
            <Input
              id="apple-team-id"
              value={attest.team_id}
              placeholder="ABCDE12345"
              className="font-mono text-xs"
              disabled={readOnly}
              onChange={(event) => patch({ team_id: event.target.value })}
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
              value={attest.bundle_id}
              placeholder="com.example.app"
              className="font-mono text-xs"
              disabled={readOnly}
              onChange={(event) => patch({ bundle_id: event.target.value })}
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
        <AppAttestEnvironments
          value={attest.environments}
          compact
          disabled={readOnly}
          onChange={(environments) =>
            state.updateAuthentication({
              ...authentication,
              app_attest: {
                team_id: attest.team_id,
                bundle_id: attest.bundle_id,
                // Production-only is the default the Worker resolves an absent
                // field to, so it is written as an absence. Storing it would
                // stamp the field onto every application that never opted in,
                // on the next unrelated edit.
                ...(environments.length === 1 && environments[0] === "production"
                  ? {}
                  : { environments }),
              },
            })
          }
        />
      </CardContent>
    </Card>
  );
}

/**
 * Whether users must be signed in, and, when they must, where they sign in.
 * The two go together: choosing sign-in is only an answer once the provider
 * that does the signing is named.
 */
function UserAuthentication({
  authentication,
  readOnly,
  state,
}: {
  authentication: AuthenticationConfig;
  readOnly: boolean;
  state: AppDraft;
}) {
  const reasonId = useId();
  const source: UserSource = authentication.end_user?.source ?? "none";
  const issuer = authIssuer(authentication);
  const choices = authentication.type === "api_key" ? SERVER_USER_CHOICES : IOS_USER_CHOICES;

  return (
    <>
      <Card>
        <CardHeader>
          <SectionHeader
            title="User authentication"
            description="Choose whether only users signed in to your app can call AI through this gateway."
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {readOnly ? (
            <DisabledReason reason={READ_ONLY_REASON} reasonId={reasonId} className="w-full">
              <ChoiceList
                label="User authentication"
                choices={choices}
                value={source}
                disabled
                describedBy={reasonId}
                onChange={() => {}}
              />
            </DisabledReason>
          ) : (
            <ChoiceList
              label="User authentication"
              choices={choices}
              value={source}
              onChange={(next) => state.setEndUserSource(next === "none" ? undefined : next)}
            />
          )}

          {authentication.type === "api_key" && authentication.end_user?.source === "header" ? (
            <Field
              label="Header name"
              htmlFor="end-user-header"
              hint={`Lowercased, and removed before the request reaches the provider. Defaults to ${DEFAULT_END_USER_HEADER}.`}
            >
              <Input
                id="end-user-header"
                value={authentication.end_user.header}
                placeholder={DEFAULT_END_USER_HEADER}
                className="max-w-[320px] font-mono text-xs"
                disabled={readOnly}
                onChange={(event) => state.updateEndUserHeader(event.target.value)}
              />
            </Field>
          ) : null}
        </CardContent>
      </Card>

      {source === "issuer" ? (
        <Card>
          <CardHeader>
            <SectionHeader
              title="Identity provider"
              description="Where your users sign in. The gateway verifies their sign-in tokens against it."
            />
          </CardHeader>
          <CardContent>
            {/* An App Attest config edited into shape without an issuer still
                opens on the defaults rather than crashing the page. */}
            <IdentityProviderFields
              issuer={issuer ?? emptyIssuer()}
              disabled={readOnly}
              onChange={state.updateIssuer}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/**
 * Whether signing in is enough, or the user must also have paid. "Paid" is
 * whatever claims the token must carry; choosing it opens the check that
 * writes them, right here, and choosing "any" drops them all.
 */
function SubscriptionCheck({
  issuer,
  readOnly,
  state,
}: {
  issuer: AuthConfig;
  readOnly: boolean;
  state: AppDraft;
}) {
  const reasonId = useId();
  const subscription = subscriptionOf(issuer);

  const choose = (next: Subscription) => {
    if (next === subscription) return;
    state.updateIssuer(
      next === "any"
        ? { entitlement: undefined, required_claims: [] }
        : { entitlement: "revenuecat", required_claims: [DEFAULT_PAID_CLAIM] },
    );
  };

  return (
    <Card>
      <CardHeader>
        <SectionHeader
          title="Subscription check"
          description="Check that the user has paid for the app before they can call AI providers through this gateway."
        />
      </CardHeader>
      <CardContent className="space-y-6">
        {readOnly ? (
          <DisabledReason reason={READ_ONLY_REASON} reasonId={reasonId} className="w-full">
            <ChoiceList
              label="Subscription check"
              choices={SUBSCRIPTION_CHOICES}
              value={subscription}
              disabled
              describedBy={reasonId}
              onChange={() => {}}
            />
          </DisabledReason>
        ) : (
          <ChoiceList
            label="Subscription check"
            choices={SUBSCRIPTION_CHOICES}
            value={subscription}
            onChange={choose}
          />
        )}

        {subscription === "paid" ? (
          <div className="border-t pt-6">
            <SubscriptionFields issuer={issuer} disabled={readOnly} onChange={state.updateIssuer} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
