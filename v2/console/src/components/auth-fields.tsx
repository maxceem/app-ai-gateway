/**
 * The fields of an app's sign-in, shared by the app's Sign-in tab and the
 * new-app wizard: how an iOS app proves itself (App Attest), who may call
 * (the end-user source and, for signed-in users, the identity provider), and
 * whether they must have paid. Each field edits the `authentication` block
 * as the gateway stores it; the rules are the contract's own schema, so the
 * console never disagrees with what the gateway accepts.
 */
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { Field } from "@/components/field";
import {
  ISSUER_PRESETS,
  buildIssuer,
  emptyIssuer,
  issuerPreset,
  matchIssuerPreset,
  paidCheckOf,
  requiresPayment,
  revenueCatClaim,
  revenueCatEntitlement,
  type IssuerDraft,
  type PaidCheck,
} from "@/lib/issuer-presets";
import {
  APP_ATTEST_ENVIRONMENTS,
  AuthenticationConfigSchema,
  DEFAULT_END_USER_HEADER,
  type AppAttestEnvironment,
  type ClaimRequirement,
} from "@contracts/app-config";

type AppAttestSettings = {
  team_id: string;
  bundle_id: string;
  environments?: AppAttestEnvironment[];
  verify_on?: "every_request" | "token_exchange";
};

type EndUserDraft =
  | { source: "none" }
  | { source: "app_install" }
  | { source: "header"; header: string }
  | { source: "issuer"; issuer: IssuerDraft };

/** An app's `authentication` as the console edits it. */
export type AuthDraft =
  | { type: "apple_app_attest"; end_user: EndUserDraft; app_attest: AppAttestSettings }
  | { type: "api_key"; end_user: EndUserDraft };

export type UserSource = EndUserDraft["source"];

/** Problems by path inside `authentication`, such as `app_attest.team_id`. */
export type AuthIssues = Map<string, string>;

/** What is wrong with a draft, by the contract's schema, keyed by where. */
export function authIssues(draft: AuthDraft): AuthIssues {
  const parsed = AuthenticationConfigSchema.safeParse(draft);
  const issues: AuthIssues = new Map();
  if (parsed.success) return issues;
  for (const issue of parsed.error.issues) {
    const where = issue.path.map(String).join(".");
    if (!issues.has(where)) issues.set(where, issue.message);
  }
  return issues;
}

/** The first problem at or under a path. */
export function issueAt(issues: AuthIssues, path: string): string | undefined {
  for (const [where, message] of issues) {
    if (where === path || where.startsWith(`${path}.`)) return message;
  }
  return undefined;
}

function Problem({ children }: { children: string | undefined }) {
  return children ? (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  ) : null;
}

// ---------------------------------------------------------------------------
// App Attest

const VERIFY_ON_CHOICES: Choice<"every_request" | "token_exchange">[] = [
  { value: "every_request", label: "Every request", description: "Each request carries a fresh App Attest assertion. A copied token is worthless." },
  { value: "token_exchange", label: "Token exchange", description: "The assertion is checked once per hourly token. Requests carry only the token." },
];

const ENVIRONMENT_LABELS: Record<AppAttestEnvironment, string> = {
  production: "Production (App Store and TestFlight builds)",
  development: "Development (builds run from Xcode)",
};

/**
 * The team and bundle Apple attests, which environments are accepted, and how
 * often. `withVerifyOn` is off in the wizard: a new app verifies every request.
 */
export function AppAttestFields({
  value,
  issues,
  disabled,
  withVerifyOn = true,
  onChange,
}: {
  value: AppAttestSettings;
  issues: AuthIssues;
  disabled?: boolean;
  withVerifyOn?: boolean;
  onChange: (next: AppAttestSettings) => void;
}) {
  const environments = value.environments ?? ["production"];
  const toggle = (environment: AppAttestEnvironment, on: boolean) => {
    const next = APP_ATTEST_ENVIRONMENTS.filter((item) => (item === environment ? on : environments.includes(item)));
    const { environments: _previous, ...rest } = value;
    // Production only is the default, so it is left out rather than written.
    onChange(next.length === 1 && next[0] === "production" ? rest : { ...rest, environments: next });
  };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Apple Team ID" htmlFor="apple-team-id" hint="Ten letters and digits, in your Apple developer account under Membership details.">
          <Input
            id="apple-team-id"
            value={value.team_id}
            placeholder="ABCDE12345"
            className="font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            aria-invalid={issueAt(issues, "app_attest.team_id") && value.team_id ? true : undefined}
            onChange={(event) => onChange({ ...value, team_id: event.target.value.toUpperCase() })}
          />
          <Problem>{value.team_id ? issueAt(issues, "app_attest.team_id") : undefined}</Problem>
        </Field>
        <Field label="Bundle ID" htmlFor="apple-bundle-id" hint="Such as com.example.app, from your target's Signing & Capabilities in Xcode.">
          <Input
            id="apple-bundle-id"
            value={value.bundle_id}
            placeholder="com.example.app"
            className="font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            aria-invalid={issueAt(issues, "app_attest.bundle_id") && value.bundle_id ? true : undefined}
            onChange={(event) => onChange({ ...value, bundle_id: event.target.value })}
          />
          <Problem>{value.bundle_id ? issueAt(issues, "app_attest.bundle_id") : undefined}</Problem>
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Accepted builds</legend>
        {APP_ATTEST_ENVIRONMENTS.map((environment) => (
          <label key={environment} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={environments.includes(environment)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(environment, checked === true)}
            />
            {ENVIRONMENT_LABELS[environment]}
          </label>
        ))}
        <Problem>{issueAt(issues, "app_attest.environments")}</Problem>
      </fieldset>
      {withVerifyOn ? (
        <Field label="Check App Attest on">
          <ChoiceList
            label="Check App Attest on"
            choices={VERIFY_ON_CHOICES}
            value={value.verify_on ?? "every_request"}
            disabled={disabled}
            onChange={(verify_on) => onChange({ ...value, verify_on })}
          />
        </Field>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who may call

export const IOS_USER_CHOICES: Choice<UserSource>[] = [
  { value: "issuer", label: "Signed-in users only", description: "Users sign in through your identity provider, and the gateway checks their sign-in token." },
  { value: "app_install", label: "Anyone with the app", description: "No sign-in. Each install counts as one user." },
];

export const SERVER_USER_CHOICES: Choice<UserSource>[] = [
  { value: "issuer", label: "Signed-in users only", description: "Your server forwards each user's sign-in token, and the gateway checks it." },
  { value: "header", label: "Your server sends the user id", description: `In a header, ${DEFAULT_END_USER_HEADER} unless you name another.` },
  { value: "none", label: "No end users", description: "Calls are not linked to any user, and limits apply to the app as a whole." },
];

/** The end-user block a source starts from, keeping an issuer already filled in. */
export function endUserFor(source: UserSource, current: EndUserDraft): EndUserDraft {
  if (source === current.source) return current;
  if (source === "issuer") return { source, issuer: emptyIssuer() };
  if (source === "header") return { source, header: DEFAULT_END_USER_HEADER };
  return { source };
}

/** Who may call: the choice, and the header a server sends the user id in. */
export function UserSourceFields({
  type,
  value,
  issues,
  disabled,
  onChange,
}: {
  type: AuthDraft["type"];
  value: EndUserDraft;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: EndUserDraft) => void;
}) {
  return (
    <div className="space-y-4">
      <ChoiceList
        label="Who may call"
        choices={type === "api_key" ? SERVER_USER_CHOICES : IOS_USER_CHOICES}
        value={value.source}
        disabled={disabled}
        onChange={(source) => onChange(endUserFor(source, value))}
      />
      {value.source === "header" ? (
        <Field label="Header name" htmlFor="end-user-header" hint="Removed before the call reaches the provider.">
          <Input
            id="end-user-header"
            value={value.header}
            placeholder={DEFAULT_END_USER_HEADER}
            className="max-w-80 font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onChange({ source: "header", header: event.target.value })}
          />
          <Problem>{issueAt(issues, "end_user.header")}</Problem>
        </Field>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity provider

/** Where users sign in: a provider, and the few things it needs. */
export function IdentityProviderFields({
  issuer,
  issues,
  disabled,
  onChange,
}: {
  issuer: IssuerDraft;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: IssuerDraft) => void;
}) {
  const { preset, values } = matchIssuerPreset(issuer);
  const write = (next: typeof preset, nextValues: Record<string, string>) =>
    onChange({ ...issuer, provider: next.id, ...buildIssuer(next, nextValues) });
  const problem = issueAt(issues, "end_user.issuer.jwks_url") ?? issueAt(issues, "end_user.issuer.issuer") ?? issueAt(issues, "end_user.issuer.audience");
  const touched = preset.inputs.some((input) => (values[input.key] ?? "").trim() !== "");
  return (
    <div className="space-y-4">
      <Field label="Identity provider" htmlFor="issuer-provider">
        <Select value={preset.id} disabled={disabled} onValueChange={(id) => write(issuerPreset(id as typeof preset.id), {})}>
          <SelectTrigger id="issuer-provider" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ISSUER_PRESETS.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{preset.description}</p>
      </Field>
      {preset.warning ? (
        <Alert>
          <AlertDescription>{preset.warning}</AlertDescription>
        </Alert>
      ) : null}
      {preset.inputs.map((input) => (
        <Field key={input.key} label={input.label} htmlFor={`issuer-${input.key}`} hint={input.hint}>
          <Input
            id={`issuer-${input.key}`}
            value={values[input.key] ?? ""}
            placeholder={input.placeholder}
            className="font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => write(preset, { ...values, [input.key]: event.target.value })}
          />
        </Field>
      ))}
      <Problem>{touched ? problem : undefined}</Problem>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paid users only

type Subscription = "any" | "paid";

const SUBSCRIPTION_CHOICES: Choice<Subscription>[] = [
  { value: "any", label: "Any signed-in user", description: "Signing in is enough. Payment is not checked." },
  { value: "paid", label: "Paid users only", description: "The sign-in token must carry a claim that says the user has paid." },
];

const PAID_CHECK_LABELS: Record<PaidCheck, string> = {
  revenuecat: "RevenueCat entitlement",
  custom: "Custom claims",
};

/** Whether signed-in users must also have paid, and which claim says so. */
export function SubscriptionFields({
  issuer,
  issues,
  disabled,
  onChange,
}: {
  issuer: IssuerDraft;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: IssuerDraft) => void;
}) {
  const paid = requiresPayment(issuer);
  const check = paidCheckOf(issuer);
  const entitlement = revenueCatEntitlement(issuer.required_claims);
  const choose = (next: Subscription) => {
    if (next === (paid ? "paid" : "any")) return;
    const { entitlement: _label, ...rest } = issuer;
    onChange(next === "any" ? { ...rest, required_claims: [] } : { ...rest, entitlement: "revenuecat", required_claims: [revenueCatClaim("")] });
  };
  const chooseCheck = (next: PaidCheck) => {
    if (next === check) return;
    onChange({ ...issuer, entitlement: next, required_claims: next === "revenuecat" ? [revenueCatClaim(entitlement ?? "")] : issuer.required_claims });
  };
  return (
    <div className="space-y-4">
      <ChoiceList label="Paid users only" choices={SUBSCRIPTION_CHOICES} value={paid ? "paid" : "any"} disabled={disabled} onChange={choose} />
      {paid ? (
        <div className="space-y-4 border-t pt-4">
          <Field label="Which claim says the user has paid" htmlFor="paid-check">
            <Select value={check} disabled={disabled} onValueChange={(next) => chooseCheck(next as PaidCheck)}>
              <SelectTrigger id="paid-check" className="w-full sm:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PAID_CHECK_LABELS) as PaidCheck[]).map((item) => (
                  <SelectItem key={item} value={item}>
                    {PAID_CHECK_LABELS[item]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {check === "revenuecat" ? (
            <Field
              label="Entitlement identifier"
              htmlFor="paid-entitlement"
              hint="In RevenueCat under Product catalog, Entitlements: the identifier, not the display name. Several, separated by commas, admit a user with any one of them."
            >
              <Input
                id="paid-entitlement"
                value={entitlement ?? ""}
                placeholder="pro"
                className="max-w-80 font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => onChange({ ...issuer, required_claims: [revenueCatClaim(event.target.value)] })}
              />
              <Problem>{issueAt(issues, "end_user.issuer.required_claims")}</Problem>
            </Field>
          ) : (
            <ClaimsEditor
              claims={issuer.required_claims}
              disabled={disabled}
              problem={issueAt(issues, "end_user.issuer.required_claims")}
              onChange={(required_claims) => onChange({ ...issuer, required_claims })}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Every claim the token must carry, one row each. */
function ClaimsEditor({
  claims,
  disabled,
  problem,
  onChange,
}: {
  claims: ClaimRequirement[];
  disabled?: boolean;
  problem: string | undefined;
  onChange: (next: ClaimRequirement[]) => void;
}) {
  const replace = (index: number, claim: ClaimRequirement) => onChange(claims.map((item, position) => (position === index ? claim : item)));
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Claims the sign-in token must carry, by dot path. Contains matches lists and space-separated scopes; equals compares exactly.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...claims, { path: "", contains: "" }])}>
          <Plus className="size-3.5" />
          Add claim
        </Button>
      </div>
      {claims.map((claim, index) => {
        const mode = claim.equals !== undefined ? "equals" : "contains";
        const text = mode === "contains" && Array.isArray(claim.contains) ? claim.contains.join(", ") : String(claim.equals ?? claim.contains ?? "");
        return (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1 space-y-1.5">
              <Label htmlFor={`claim-path-${index}`} className="text-xs text-muted-foreground">
                Path
              </Label>
              <Input
                id={`claim-path-${index}`}
                value={claim.path}
                placeholder="entitlements"
                className="font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => replace(index, { ...claim, path: event.target.value })}
              />
            </div>
            <div className="w-36 space-y-1.5">
              <Label htmlFor={`claim-mode-${index}`} className="text-xs text-muted-foreground">
                Match
              </Label>
              <Select
                value={mode}
                disabled={disabled}
                onValueChange={(next) => replace(index, next === "equals" ? { path: claim.path, equals: text } : { path: claim.path, contains: text })}
              >
                <SelectTrigger id={`claim-mode-${index}`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">contains</SelectItem>
                  <SelectItem value="equals">equals</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-44 flex-1 space-y-1.5">
              <Label htmlFor={`claim-value-${index}`} className="text-xs text-muted-foreground">
                Value
              </Label>
              <Input
                id={`claim-value-${index}`}
                value={text}
                placeholder={mode === "contains" ? "pro, pro_test" : "pro"}
                className="font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => {
                  if (mode === "equals") {
                    replace(index, { path: claim.path, equals: event.target.value });
                    return;
                  }
                  const values = event.target.value.split(",").map((value) => value.trim());
                  replace(index, { path: claim.path, contains: values.length > 1 ? values : event.target.value });
                }}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove claim ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(claims.filter((_, position) => position !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
      <Problem>{problem}</Problem>
    </div>
  );
}
