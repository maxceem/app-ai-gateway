/**
 * The fields of an app's sign-in, shared by the app's Sign-in tab and the
 * new-app wizard: how an iOS app proves itself (App Attest), who may call
 * (the end-user source and, for signed-in users, the identity provider), and
 * whether they must have paid. Each field edits a copy of the stored
 * `authentication` block in place, so a field the person does not change
 * keeps its stored value, and the rules are the contract's own schema.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { Field } from "@/components/field";
import {
  ISSUER_PRESETS,
  buildIssuer,
  emptyIssuer,
  issuerPreset,
  matchIssuerPreset,
  missingInputs,
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

export type EndUserDraft =
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

/** What is wrong with a draft, by the contract's schema and the form's own rules, keyed by where. */
export function authIssues(draft: AuthDraft): AuthIssues {
  const issues: AuthIssues = new Map();
  const parsed = AuthenticationConfigSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.map(String).join(".");
      if (!issues.has(where)) issues.set(where, issue.message);
    }
  }
  const endUser = draft.end_user;
  if (endUser.source === "issuer") {
    const { preset, values } = matchIssuerPreset(endUser.issuer);
    const missing = missingInputs(preset, values)[0];
    if (missing && !issues.has("end_user.issuer.preset")) issues.set("end_user.issuer.preset", `Enter the ${missing.label.toLowerCase()}.`);
    const claims = endUser.issuer.required_claims;
    if (requiresPayment(endUser.issuer) && claims.length === 0) {
      issues.set("end_user.issuer.required_claims", "Add at least one claim, or choose Any signed-in user.");
    }
    claims.forEach((claim, index) => {
      if (claim.equals !== undefined && typeof claim.equals === "string" && claimTypes.get(claim) === "number") {
        issues.set(`end_user.issuer.required_claims.${index}.equals`, "Enter a number.");
      }
    });
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
    onChange({ ...value, environments: next });
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

/** The end-user block a source starts from when it has none yet. */
function freshEndUser(source: UserSource): EndUserDraft {
  if (source === "issuer") return { source, issuer: emptyIssuer() };
  if (source === "header") return { source, header: DEFAULT_END_USER_HEADER };
  return { source };
}

/**
 * Who may call: the choice, and the header a server sends the user id in.
 * Each source keeps what it held while another is chosen, so switching away
 * and back brings the stored issuer or header back as it was. `value` is null
 * until the wizard's question is answered.
 */
export function UserSourceFields({
  type,
  value,
  issues,
  disabled,
  onChange,
}: {
  type: AuthDraft["type"];
  value: EndUserDraft | null;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: EndUserDraft) => void;
}) {
  const held = useRef<Partial<Record<UserSource, EndUserDraft>>>({});
  const choose = (source: UserSource) => {
    if (value?.source === source) return;
    if (value) held.current[value.source] = value;
    onChange(held.current[source] ?? freshEndUser(source));
  };
  return (
    <div className="space-y-4">
      <ChoiceList
        label="Who may call"
        choices={type === "api_key" ? SERVER_USER_CHOICES : IOS_USER_CHOICES}
        value={value?.source ?? null}
        disabled={disabled}
        onChange={choose}
      />
      {value?.source === "header" ? (
        <Field label="Header name" htmlFor="end-user-header" hint="Removed before the call reaches the provider.">
          <Input
            id="end-user-header"
            value={value.header}
            placeholder={DEFAULT_END_USER_HEADER}
            className="max-w-80 font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onChange({ ...value, header: event.target.value })}
          />
          <Problem>{issueAt(issues, "end_user.header")}</Problem>
        </Field>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity provider

/** A value written as the stored one was: a list stays a list, one value of one stays as it was. */
function keepShape(stored: string | string[], next: string): string | string[] {
  if (Array.isArray(stored)) return stored.length === 1 && stored[0] === next ? stored : [next];
  return next;
}

/** Lines typed one value each, written as a single value when the stored one was and there is one line. */
function listFrom(stored: string | string[], text: string): string | string[] {
  const values = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!Array.isArray(stored) && values.length <= 1) return text.trim();
  return values;
}

const linesOf = (value: string | string[]) => (Array.isArray(value) ? value.join("\n") : value);

/**
 * A list of values, one per line. The text is held here while it is typed,
 * so a new empty line can be started; it follows the stored value whenever
 * that changes to something the text does not already say.
 */
function ListArea({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string | string[];
  disabled?: boolean;
  onChange: (next: string | string[]) => void;
}) {
  const [text, setText] = useState(() => linesOf(value));
  useEffect(() => {
    if (JSON.stringify(listFrom(value, text)) !== JSON.stringify(value)) setText(linesOf(value));
    // Only a change from outside resets the text.
  }, [value]);
  return (
    <Textarea
      id={id}
      value={text}
      className="min-h-16 font-mono text-xs"
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        onChange(listFrom(value, event.target.value));
      }}
    />
  );
}

/** Where users sign in: a provider, and the few things it needs, or every field for a custom issuer. */
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
  /** Writes what the preset builds, changing only the fields whose value moves. */
  const write = (next: typeof preset, nextValues: Record<string, string>) => {
    const built = buildIssuer(next, nextValues);
    onChange({
      ...issuer,
      provider: next.id,
      jwks_url: built.jwks_url,
      issuer: keepShape(issuer.issuer, built.issuer),
      audience: keepShape(issuer.audience, built.audience),
    });
  };
  const choose = (id: string) => {
    const next = issuerPreset(id as typeof preset.id);
    if (next.id === preset.id) return;
    // The custom editor starts from what is stored; a preset starts empty.
    if (next.id === "custom") onChange({ ...issuer, provider: "custom" });
    else write(next, {});
  };
  const problem = issueAt(issues, "end_user.issuer.jwks_url") ?? issueAt(issues, "end_user.issuer.issuer") ?? issueAt(issues, "end_user.issuer.audience");
  const missing = issueAt(issues, "end_user.issuer.preset");
  return (
    <div className="space-y-4">
      <Field label="Identity provider" htmlFor="issuer-provider">
        <Select value={preset.id} disabled={disabled} onValueChange={choose}>
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
      {preset.id === "custom" ? (
        <>
          <Field label="JWKS URL" htmlFor="issuer-jwks_url" hint="Where the issuer publishes its keys, over HTTPS.">
            <Input
              id="issuer-jwks_url"
              value={issuer.jwks_url}
              placeholder="https://issuer.example.com/.well-known/jwks.json"
              className="font-mono text-xs"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => onChange({ ...issuer, jwks_url: event.target.value })}
            />
            <Problem>{issueAt(issues, "end_user.issuer.jwks_url")}</Problem>
          </Field>
          <Field label="Issuers (iss)" htmlFor="issuer-issuer" hint="One per line: a token is accepted from any of them. Exactly as your tokens carry it, trailing slash included.">
            <ListArea id="issuer-issuer" value={issuer.issuer} disabled={disabled} onChange={(next) => onChange({ ...issuer, issuer: next })} />
            <Problem>{issueAt(issues, "end_user.issuer.issuer")}</Problem>
          </Field>
          <Field label="Audiences (aud)" htmlFor="issuer-audience" hint="One per line: a token for any of them is accepted.">
            <ListArea id="issuer-audience" value={issuer.audience} disabled={disabled} onChange={(next) => onChange({ ...issuer, audience: next })} />
            <Problem>{issueAt(issues, "end_user.issuer.audience")}</Problem>
          </Field>
        </>
      ) : (
        <>
          {preset.inputs.map((input) => (
            <Field key={input.key} label={input.label} htmlFor={`issuer-${input.key}`} hint={input.hint}>
              <Input
                id={`issuer-${input.key}`}
                value={values[input.key] ?? ""}
                placeholder={input.placeholder}
                className="font-mono text-xs"
                autoComplete="off"
                required
                disabled={disabled}
                onChange={(event) => write(preset, { ...values, [input.key]: event.target.value })}
              />
            </Field>
          ))}
          <Problem>{missing ?? problem}</Problem>
        </>
      )}
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
                onChange={(event) => onChange({ ...issuer, required_claims: [{ ...issuer.required_claims[0], ...revenueCatClaim(event.target.value) }] })}
              />
              <Problem>{issueAt(issues, "end_user.issuer.required_claims")}</Problem>
            </Field>
          ) : (
            <ClaimsEditor
              claims={issuer.required_claims}
              issues={issues}
              disabled={disabled}
              onChange={(required_claims) => onChange({ ...issuer, required_claims })}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

type ClaimMode = "contains" | "string" | "number" | "boolean";

const CLAIM_MODE_LABELS: Record<ClaimMode, string> = {
  contains: "contains",
  string: "equals text",
  number: "equals number",
  boolean: "equals true or false",
};

/**
 * The type an `equals` claim is being typed as, kept while a number is still
 * half typed (stored as text until it reads as a number).
 */
const claimTypes = new WeakMap<ClaimRequirement, ClaimMode>();

function modeOf(claim: ClaimRequirement): ClaimMode {
  if (claim.equals === undefined) return "contains";
  return claimTypes.get(claim) ?? (typeof claim.equals === "number" ? "number" : typeof claim.equals === "boolean" ? "boolean" : "string");
}

const NUMBER = /^-?\d+(?:\.\d+)?$/u;

/** A claim in a mode, keeping its path and what can be kept of its value. */
function claimIn(claim: ClaimRequirement, mode: ClaimMode, text: string): ClaimRequirement {
  const { contains: _contains, equals: _equals, ...rest } = claim;
  let next: ClaimRequirement;
  if (mode === "contains") {
    const values = text.split(",").map((value) => value.trim());
    next = { ...rest, contains: values.length > 1 ? values : text };
  } else if (mode === "boolean") {
    next = { ...rest, equals: text === "true" };
  } else if (mode === "number") {
    next = { ...rest, equals: NUMBER.test(text.trim()) ? Number(text.trim()) : text };
  } else {
    next = { ...rest, equals: text };
  }
  claimTypes.set(next, mode);
  return next;
}

/** Every claim the token must carry, one row each. */
function ClaimsEditor({
  claims,
  issues,
  disabled,
  onChange,
}: {
  claims: ClaimRequirement[];
  issues: AuthIssues;
  disabled?: boolean;
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
        const mode = modeOf(claim);
        const text = claim.equals === undefined ? (Array.isArray(claim.contains) ? claim.contains.join(", ") : (claim.contains ?? "")) : String(claim.equals);
        return (
          <div key={index} className="space-y-1">
            <div className="flex flex-wrap items-end gap-2">
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
                  onChange={(event) => {
                    const next = { ...claim, path: event.target.value };
                    claimTypes.set(next, mode);
                    replace(index, next);
                  }}
                />
              </div>
              <div className="w-44 space-y-1.5">
                <Label htmlFor={`claim-mode-${index}`} className="text-xs text-muted-foreground">
                  Match
                </Label>
                <Select
                  value={mode}
                  disabled={disabled}
                  onValueChange={(next) => replace(index, claimIn(claim, next as ClaimMode, next === "boolean" ? "true" : text))}
                >
                  <SelectTrigger id={`claim-mode-${index}`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CLAIM_MODE_LABELS) as ClaimMode[]).map((item) => (
                      <SelectItem key={item} value={item}>
                        {CLAIM_MODE_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-44 flex-1 space-y-1.5">
                <Label htmlFor={`claim-value-${index}`} className="text-xs text-muted-foreground">
                  Value
                </Label>
                {mode === "boolean" ? (
                  <Select value={String(claim.equals)} disabled={disabled} onValueChange={(next) => replace(index, claimIn(claim, "boolean", next))}>
                    <SelectTrigger id={`claim-value-${index}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">true</SelectItem>
                      <SelectItem value="false">false</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={`claim-value-${index}`}
                    value={text}
                    inputMode={mode === "number" ? "decimal" : undefined}
                    placeholder={mode === "contains" ? "pro, pro_test" : mode === "number" ? "3" : "pro"}
                    className="font-mono text-xs"
                    autoComplete="off"
                    disabled={disabled}
                    onChange={(event) => replace(index, claimIn(claim, mode, event.target.value))}
                  />
                )}
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
            <Problem>{issueAt(issues, `end_user.issuer.required_claims.${index}`)}</Problem>
          </div>
        );
      })}
      {claims.length === 0 ? <Problem>{issueAt(issues, "end_user.issuer.required_claims")}</Problem> : null}
    </div>
  );
}
