/**
 * The fields of an app's sign-in, shared by the app's Sign-in tab and the
 * new-app wizard: how an iOS app proves itself (App Attest), who may call
 * (the end-user source and, for signed-in users, the identity provider), and
 * whether they must have paid. Each field edits a copy of the stored
 * `authentication` block in place, so a field the person does not change
 * keeps its stored value, and the rules are the contract's own schema.
 */
import { useRef } from "react";
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
  REVENUECAT_CLAIM_PATH,
  buildIssuer,
  emptyIssuer,
  issuerPreset,
  matchIssuerPreset,
  missingInputs,
  requiresPayment,
  type IssuerDraft,
} from "@/lib/issuer-presets";
import {
  APP_ATTEST_ENVIRONMENTS,
  AuthenticationConfigSchema,
  DEFAULT_END_USER_HEADER,
  type AppAttestEnvironment,
  type ClaimRequirement,
} from "@contracts/app-config";

/**
 * A claim as the form holds it: the stored requirement, plus the match type
 * the person chose (`_match`), kept in the draft beside the typed text so a
 * type change alone is an edit. `authForSave` drops it.
 */
type ClaimDraft = ClaimRequirement & { _match?: ClaimMode };

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

/**
 * What is wrong with a draft, by the contract's schema and the form's own
 * rules, keyed by where. Fields this console does not know, which a newer
 * gateway may have written, are left to the gateway: they are sent back as
 * stored, and only the fields the form knows are judged here.
 *
 * `paid` is whether the person chose paid users only, which a draft whose
 * last claim was just removed no longer says by itself.
 */
export function authIssues(draft: AuthDraft, { paid }: { paid?: boolean } = {}): AuthIssues {
  const issues: AuthIssues = new Map();
  const parsed = AuthenticationConfigSchema.safeParse(authForSave(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") continue;
      const where = issue.path.map(String).join(".");
      if (!issues.has(where)) issues.set(where, issue.message);
    }
  }
  const endUser = draft.end_user;
  if (endUser.source === "issuer") {
    const { preset, values } = matchIssuerPreset(endUser.issuer);
    // A named provider asks for its own inputs; a custom issuer is judged by the gateway's schema alone.
    const missing = preset.id === "custom" ? undefined : missingInputs(preset, values)[0];
    if (missing && !issues.has("end_user.issuer.preset")) issues.set("end_user.issuer.preset", `Enter the ${missing.label.toLowerCase()}.`);
    const claims = endUser.issuer.required_claims;
    if ((paid ?? requiresPayment(endUser.issuer)) && claims.length === 0) {
      issues.set("end_user.issuer.required_claims", "Add at least one claim, or choose Any signed-in user.");
    }
    (claims as ClaimDraft[]).forEach((claim, index) => {
      if (claim._match === "boolean" && typeof claim.equals !== "boolean") {
        issues.set(`end_user.issuer.required_claims.${index}.equals`, "Choose true or false.");
      }
      if (claim._match === "number" && typeof claim.equals === "string" && !NUMBER.test(claim.equals.trim())) {
        issues.set(`end_user.issuer.required_claims.${index}.equals`, "Enter a number, such as 3 or 1.05.");
      }
    });
  }
  return issues;
}

/**
 * The block as it is saved: a number claim is typed as text, so a half-typed
 * number such as `1.` stays as typed in the form, and becomes a number only
 * here.
 */
export function authForSave(draft: AuthDraft): AuthDraft {
  const endUser = draft.end_user;
  if (endUser.source !== "issuer") return draft;
  const claims = endUser.issuer.required_claims as ClaimDraft[];
  if (!claims.some((claim) => claim._match !== undefined)) return draft;
  const required_claims = claims.map(({ _match, ...claim }) =>
    _match === "number" && typeof claim.equals === "string" && NUMBER.test(claim.equals.trim()) ? { ...claim, equals: Number(claim.equals.trim()) } : claim,
  );
  return { ...draft, end_user: { ...endUser, issuer: { ...endUser.issuer, required_claims } } } as AuthDraft;
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

/**
 * A value that is one string or a list of them, one input per value, each
 * kept exactly as typed or stored. A single stored string stays a string
 * until a second value is added.
 */
function ValuesEditor({
  id,
  label,
  value,
  issuePath,
  issues,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string | string[];
  issuePath: string;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: string | string[]) => void;
}) {
  const values = Array.isArray(value) ? value : [value];
  const write = (next: string[]) => onChange(Array.isArray(value) || next.length !== 1 ? next : next[0]!);
  return (
    <div className="space-y-2">
      {values.map((item, index) => {
        // A value with a line break cannot be shown in a one-line input without changing it, so it is shown as it is.
        const multiline = /[\r\n]/u.test(item);
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2">
              {multiline ? (
                <div className="flex-1 space-y-0.5">
                  <pre
                    id={index === 0 ? id : `${id}-${index}`}
                    aria-label={`${label} ${index + 1}`}
                    className="rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-xs whitespace-pre-wrap"
                  >
                    {item}
                  </pre>
                  <p className="text-xs text-muted-foreground">Contains a line break, so it cannot be edited here. Edit it through the CLI or the API.</p>
                </div>
              ) : (
                <Input
                  id={index === 0 ? id : `${id}-${index}`}
                  aria-label={index === 0 ? undefined : `${label} ${index + 1}`}
                  value={item}
                  className="font-mono text-xs"
                  autoComplete="off"
                  disabled={disabled}
                  onChange={(event) => write(values.map((entry, position) => (position === index ? event.target.value : entry)))}
                />
              )}
              {values.length > 1 || multiline ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                  disabled={disabled}
                  onClick={() => write(values.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
            <Problem>{Array.isArray(value) ? issueAt(issues, `${issuePath}.${index}`) : issueAt(issues, issuePath)}</Problem>
          </div>
        );
      })}
      {Array.isArray(value) ? <Problem>{issues.get(issuePath)}</Problem> : null}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => write([...values, ""])}>
        <Plus className="size-3.5" />
        Add {label.toLowerCase()}
      </Button>
    </div>
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
          <Field label="Issuer (iss)" htmlFor="issuer-issuer" hint="Exactly as your tokens carry it, trailing slash included. With several, a token from any of them is accepted.">
            <ValuesEditor
              id="issuer-issuer"
              label="Issuer"
              value={issuer.issuer}
              issuePath="end_user.issuer.issuer"
              issues={issues}
              disabled={disabled}
              onChange={(next) => onChange({ ...issuer, issuer: next })}
            />
          </Field>
          <Field label="Audience (aud)" htmlFor="issuer-audience" hint="With several, a token for any of them is accepted.">
            <ValuesEditor
              id="issuer-audience"
              label="Audience"
              value={issuer.audience}
              issuePath="end_user.issuer.audience"
              issues={issues}
              disabled={disabled}
              onChange={(next) => onChange({ ...issuer, audience: next })}
            />
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

/**
 * Whether signed-in users must also have paid, and which claims say so: one
 * list of claim rows, each edited as stored, path included. RevenueCat is a
 * helper that adds a row in the shape it writes, not a mode, so nothing is
 * recreated or erased by switching.
 *
 * `paid` is the person's choice, held by the form: removing the last claim
 * does not quietly turn the check off, only choosing Any signed-in user does.
 */
export function SubscriptionFields({
  issuer,
  paid,
  issues,
  disabled,
  onChange,
  onPaidChange,
}: {
  issuer: IssuerDraft;
  paid: boolean;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: IssuerDraft) => void;
  onPaidChange: (paid: boolean) => void;
}) {
  const choose = (next: Subscription) => {
    if (next === (paid ? "paid" : "any")) return;
    onPaidChange(next === "paid");
    // Any signed-in user drops the claims and the console's own label for them; paid users only starts from what is there.
    if (next === "any") {
      const { entitlement: _label, ...rest } = issuer;
      onChange({ ...rest, required_claims: [] });
    }
  };
  return (
    <div className="space-y-4">
      <ChoiceList label="Paid users only" choices={SUBSCRIPTION_CHOICES} value={paid ? "paid" : "any"} disabled={disabled} onChange={choose} />
      {paid ? (
        <div className="space-y-4 border-t pt-4">
          <ClaimsEditor
            claims={issuer.required_claims}
            issues={issues}
            disabled={disabled}
            onChange={(required_claims) => onChange({ ...issuer, required_claims })}
          />
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

function modeOf(claim: ClaimDraft): ClaimMode {
  if (claim.equals === undefined) return "contains";
  return claim._match ?? (typeof claim.equals === "number" ? "number" : typeof claim.equals === "boolean" ? "boolean" : "string");
}

const NUMBER = /^-?\d+(?:\.\d+)?$/u;

/** A claim in a mode, keeping its path and what can be kept of its value, with the mode chosen. */
function claimIn(claim: ClaimDraft, mode: ClaimMode, text: string): ClaimDraft {
  const { contains: _contains, equals: _equals, _match: _previous, ...rest } = claim;
  let next: ClaimDraft;
  if (mode === "contains") {
    next = { ...rest, contains: text };
  } else if (mode === "boolean") {
    // Only true or false carries over; anything else starts unanswered, and saving needs a choice.
    next = { ...rest, equals: text === "true" ? true : text === "false" ? false : "" };
  } else if (mode === "number") {
    // Kept as typed; `authForSave` makes it a number.
    next = { ...rest, equals: text };
  } else {
    next = { ...rest, equals: text };
  }
  // The type is kept in the draft only where the value alone does not say it (a number still typed as text,
  // a true or false not chosen yet), so a claim that returns to its stored value is no edit.
  return modeOf(next) === mode ? next : { ...next, _match: mode };
}

/** Every claim the token must carry, one row each. */
function ClaimsEditor({
  claims,
  issues,
  disabled,
  onChange,
}: {
  claims: ClaimDraft[];
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: ClaimDraft[]) => void;
}) {
  const replace = (index: number, claim: ClaimDraft) => onChange(claims.map((item, position) => (position === index ? claim : item)));
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Claims the sign-in token must carry, by dot path. Contains matches lists and space-separated scopes; equals compares exactly.
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...claims, { path: "", contains: "" }])}>
            <Plus className="size-3.5" />
            Add claim
          </Button>
          {/* A helper, not a mode: it adds one row in the shape RevenueCat's Firebase function kit writes. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...claims, { path: REVENUECAT_CLAIM_PATH, contains: "" }])}
          >
            <Plus className="size-3.5" />
            Add RevenueCat entitlement
          </Button>
        </div>
      </div>
      {claims.map((claim, index) => {
        const mode = modeOf(claim);
        // What a change of match type carries over: the value, or the first of several.
        const text = claim.equals === undefined ? (Array.isArray(claim.contains) ? (claim.contains[0] ?? "") : (claim.contains ?? "")) : String(claim.equals);
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
                  onChange={(event) => replace(index, { ...claim, path: event.target.value })}
                />
              </div>
              <div className="w-44 space-y-1.5">
                <Label htmlFor={`claim-mode-${index}`} className="text-xs text-muted-foreground">
                  Match
                </Label>
                <Select
                  value={mode}
                  disabled={disabled}
                  onValueChange={(next) => replace(index, claimIn(claim, next as ClaimMode, text))}
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
                  <Select
                    value={typeof claim.equals === "boolean" ? String(claim.equals) : ""}
                    disabled={disabled}
                    onValueChange={(next) => replace(index, claimIn(claim, "boolean", next))}
                  >
                    <SelectTrigger id={`claim-value-${index}`} className="w-full">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">true</SelectItem>
                      <SelectItem value="false">false</SelectItem>
                    </SelectContent>
                  </Select>
                ) : mode === "contains" ? (
                  // Each value its own input, so a comma inside one stays part of it.
                  <ValuesEditor
                    id={`claim-value-${index}`}
                    label="Value"
                    value={claim.contains ?? ""}
                    issuePath={`end_user.issuer.required_claims.${index}.contains`}
                    issues={issues}
                    disabled={disabled}
                    onChange={(contains) => replace(index, { ...claim, contains })}
                  />
                ) : (
                  <Input
                    id={`claim-value-${index}`}
                    value={text}
                    inputMode={mode === "number" ? "decimal" : undefined}
                    placeholder={mode === "number" ? "3" : "pro"}
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
            {claim.path === REVENUECAT_CLAIM_PATH ? (
              <p className="text-xs text-muted-foreground">
                A RevenueCat entitlement: in RevenueCat under Product catalog, Entitlements, the identifier, not the display name. With several, a
                user with any one of them is admitted. The claim is where RevenueCat's Firebase function kit puts it.
              </p>
            ) : null}
            <Problem>{issueAt(issues, `end_user.issuer.required_claims.${index}`)}</Problem>
          </div>
        );
      })}
      {claims.length === 0 ? <Problem>{issueAt(issues, "end_user.issuer.required_claims")}</Problem> : null}
    </div>
  );
}
