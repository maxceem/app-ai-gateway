/**
 * An app's sign-in as the console edits it, shared by the app's Sign-in tab
 * and the new-app wizard: how an iOS app proves itself (App Attest), who may
 * call (the end-user source and, for signed-in users, the identity
 * provider), and whether they must have paid.
 *
 * The form edits a `SignInDraft`, with explicit types for what the person is
 * working on, and `signInConfig` turns it into the stored block in one place.
 * Each part keeps the stored object it came from, so a field the form does
 * not show, or one the person did not touch, is written back as it was; and
 * the rules are the contract's own schema.
 *
 * One rule for remembering earlier answers: each choice (who may call, the
 * identity provider, a claim's match type) keeps what the other answers
 * held inside the draft, so switching away and back brings them back. A new
 * draft, after a save or a discard, starts from the stored block alone.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChoiceList, type Choice } from "@/components/choice-list";
import { Field } from "@/components/field";
import { Problem } from "@/components/problem";
import {
  ISSUER_PRESETS,
  REVENUECAT_CLAIM_PATH,
  buildIssuer,
  emptyIssuer,
  issuerPreset,
  matchIssuerPreset,
  missingInputs,
  type IssuerProvider,
} from "@/lib/issuer-presets";
import {
  APP_ATTEST_ENVIRONMENTS,
  AuthenticationConfigSchema,
  DEFAULT_END_USER_HEADER,
  type AppAttestEnvironment,
  type AuthenticationConfig,
  type ClaimRequirement,
  type IssuerAuthentication,
} from "@contracts/app-config";
import { sameJson } from "@contracts/canonical-json";

// ---------------------------------------------------------------------------
// The draft

export type UserSource = AuthenticationConfig["end_user"]["source"];
export type ClaimMode = "contains" | "string" | "number" | "boolean";

/** What a claim row holds in one match type: the values it contains, or the text it equals. */
interface ClaimAnswer {
  values: string[];
  text: string;
}

/** One claim the token must carry, as the form edits it. */
export interface ClaimRow {
  /** The stored claim this row edits, or null for a new one. */
  original: ClaimRequirement | null;
  path: string;
  mode: ClaimMode;
  /** `contains` values, one per input. */
  values: string[];
  /** Whether the stored `contains` was a list: one value of one that was not stays a plain string. */
  listed: boolean;
  /** The `equals` value as typed: text, a number being typed, or `true`, `false`, or "" for not chosen yet. */
  text: string;
  /** What each other match type last held, brought back when it is chosen again. */
  earlier: Partial<Record<ClaimMode, ClaimAnswer>>;
}

/** The issuer fields a provider's editor holds. */
interface IssuerAnswer {
  values: Record<string, string>;
  jwks_url: string;
  issuer: string[];
  audience: string[];
}

/** The identity provider and paid check, as the form edits them. */
export interface IssuerForm {
  /** The stored issuer, kept for the fields the form does not show (`token_header` and the like). */
  original: IssuerAuthentication;
  /** The editor shown: a named provider, or `custom` with every field. */
  provider: IssuerProvider;
  /** A named provider's own inputs. */
  values: Record<string, string>;
  /** The custom editor's fields. */
  jwks_url: string;
  issuer: string[];
  audience: string[];
  claims: ClaimRow[];
  /** What each other provider's editor last held. */
  earlier: Partial<Record<IssuerProvider, IssuerAnswer>>;
}

type AppAttestSettings = Extract<AuthenticationConfig, { type: "apple_app_attest" }>["app_attest"];

/**
 * An app's sign-in as the form edits it. The header and the issuer are kept
 * whichever caller choice is made, so choosing another and coming back finds
 * them as they were.
 */
export interface SignInDraft {
  /** The stored block, kept for the fields the form does not show. */
  original: AuthenticationConfig;
  appAttest: AppAttestSettings | null;
  /** Who may call; null until the wizard's question is answered. */
  source: UserSource | null;
  header: string;
  issuer: IssuerForm;
}

function rowOf(claim: ClaimRequirement): ClaimRow {
  const row: ClaimRow = { original: claim, path: claim.path, mode: "contains", values: [""], listed: false, text: "", earlier: {} };
  if (claim.equals !== undefined) {
    const mode: ClaimMode = typeof claim.equals === "number" ? "number" : typeof claim.equals === "boolean" ? "boolean" : "string";
    return { ...row, mode, text: String(claim.equals) };
  }
  const contains = claim.contains ?? "";
  return { ...row, values: Array.isArray(contains) ? [...contains] : [contains], listed: Array.isArray(contains) };
}

/** A new claim row, contains, with one empty value. */
export function newClaimRow(path = ""): ClaimRow {
  return { original: null, path, mode: "contains", values: [""], listed: false, text: "", earlier: {} };
}

function issuerFormOf(stored: IssuerAuthentication): IssuerForm {
  const { preset, values } = matchIssuerPreset(stored);
  return {
    original: stored,
    provider: preset.id,
    values,
    jwks_url: stored.jwks_url,
    issuer: [...stored.issuer],
    audience: [...stored.audience],
    claims: stored.required_claims.map(rowOf),
    earlier: {},
  };
}

/** The stored block as the form starts editing it. */
export function signInDraftOf(stored: AuthenticationConfig, { unanswered = false }: { unanswered?: boolean } = {}): SignInDraft {
  const endUser = stored.end_user;
  return {
    original: stored,
    appAttest: stored.type === "apple_app_attest" ? structuredClone(stored.app_attest) : null,
    source: unanswered ? null : endUser.source,
    header: endUser.source === "header" ? endUser.header : DEFAULT_END_USER_HEADER,
    issuer: issuerFormOf(endUser.source === "issuer" ? endUser.issuer : emptyIssuer()),
  };
}

/** Whether a row still says what its stored claim said, however it got there. */
function pristine(row: ClaimRow): boolean {
  if (row.original === null) return false;
  const stored = rowOf(row.original);
  return row.path === stored.path && row.mode === stored.mode && sameJson(row.values, stored.values) && row.text === stored.text;
}

/** A claim row as the gateway stores it. A row back at its stored claim is that claim, exactly. */
function claimOf(row: ClaimRow): ClaimRequirement {
  if (row.original !== null && pristine(row)) return row.original;
  const { contains: _contains, equals: _equals, ...kept } = row.original ?? { path: "" };
  const claim: ClaimRequirement = { ...kept, path: row.path };
  if (row.mode === "contains") claim.contains = !row.listed && row.values.length === 1 ? row.values[0]! : row.values;
  else if (row.mode === "string") claim.equals = row.text;
  else if (row.mode === "number") claim.equals = exactNumber(row.text) ? Number(row.text.trim()) : row.text;
  else claim.equals = row.text === "true" ? true : row.text === "false" ? false : row.text;
  return claim;
}

/** The issuer fields the editor shown writes: a named provider's built from its inputs, the custom editor's as typed. */
function issuerFields(form: IssuerForm): Pick<IssuerAuthentication, "jwks_url" | "issuer" | "audience"> {
  if (form.provider === "custom") return { jwks_url: form.jwks_url, issuer: form.issuer, audience: form.audience };
  const built = buildIssuer(issuerPreset(form.provider), form.values);
  return { jwks_url: built.jwks_url, issuer: [built.issuer], audience: [built.audience] };
}

function issuerOf(form: IssuerForm): IssuerAuthentication {
  const issuer: IssuerAuthentication = { ...form.original, ...issuerFields(form), required_claims: form.claims.map(claimOf) };
  // The provider label is written only when the editor shown is not the one the stored issuer opens in.
  if (form.provider !== matchIssuerPreset(form.original).preset.id) issuer.provider = form.provider;
  return issuer;
}

/** The block a draft saves as: the one place the draft becomes configuration. */
export function signInConfig(draft: SignInDraft): AuthenticationConfig {
  const { original } = draft;
  const source = draft.source ?? original.end_user.source;
  const kept = original.end_user.source === source ? original.end_user : { source };
  const endUser =
    source === "header"
      ? { ...kept, source, header: draft.header }
      : source === "issuer"
        ? { ...kept, source, issuer: issuerOf(draft.issuer) }
        : { ...(kept as object), source };
  const config = { ...original, end_user: endUser } as AuthenticationConfig;
  if (config.type === "apple_app_attest" && draft.appAttest !== null) config.app_attest = draft.appAttest;
  return config;
}

/** Whether a row's value is still being typed: a number that is not one yet, or a true or false not chosen. */
function unfinished(row: ClaimRow): boolean {
  if (pristine(row)) return false;
  if (row.mode === "number") return !exactNumber(row.text);
  if (row.mode === "boolean") return row.text !== "true" && row.text !== "false";
  return false;
}

/**
 * What of a draft counts as an edit: the block it would save, and any row
 * still being typed. A value back at its stored one is no edit, whatever it
 * passed through, and what the other choices remember is not an edit either.
 */
export function signInEdits(draft: SignInDraft): unknown {
  return { save: signInConfig(draft), typing: draft.issuer.claims.map((row) => (unfinished(row) ? [row.mode, row.text] : null)) };
}

// ---------------------------------------------------------------------------
// Checks

/** Problems by path inside `authentication`, such as `app_attest.team_id`. */
export type AuthIssues = Map<string, string>;

/**
 * What is wrong with a draft, by the contract's schema and the form's own
 * rules, keyed by where. Fields this console does not know, which a newer
 * gateway may have written, are left to the gateway: they are sent back as
 * stored, and only the fields the form knows are judged here.
 */
export function signInIssues(draft: SignInDraft): AuthIssues {
  const issues: AuthIssues = new Map();
  const parsed = AuthenticationConfigSchema.safeParse(signInConfig(draft));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") continue;
      const where = issue.path.map(String).join(".");
      if (!issues.has(where)) issues.set(where, issue.message);
    }
  }
  if (draft.source === "issuer") {
    const form = draft.issuer;
    // A named provider asks for its own inputs; a custom issuer is judged by the gateway's schema alone.
    const missing = form.provider === "custom" ? undefined : missingInputs(issuerPreset(form.provider), form.values)[0];
    if (missing) issues.set("end_user.issuer.preset", `Enter the ${missing.label.toLowerCase()}.`);
    form.claims.forEach((row, index) => {
      if (!unfinished(row)) return;
      issues.set(
        `end_user.issuer.required_claims.${index}.equals`,
        row.mode === "boolean"
          ? "Choose true or false."
          : NUMBER.test(row.text.trim())
            ? "This number cannot be kept exactly. A large id must be text, in the token and in this rule: choose equals text."
            : "Enter a number, such as 3 or 1.05.",
      );
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

/** A number as typed: digits, an optional fraction, an optional exponent. */
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * Whether typed text is a number JSON keeps exactly. A whole number, however
 * it is written (`9007199254740992`, `9007199254740992.0`, `9.007199254740992e15`),
 * must be within the safe range: beyond it, `9007199254740993` would become
 * `9007199254740992`, and the rule would check another value. Any other
 * number must be a plain decimal that reads back as written (trailing zeros
 * aside).
 */
function exactNumber(text: string): boolean {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return false;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return false;
  if (Number.isInteger(value)) return Number.isSafeInteger(value);
  if (/[eE]/u.test(trimmed)) return false;
  const written = trimmed.replace(/0+$/u, "").replace(/\.$/u, "").replace(/^(-?)0+(?=\d)/u, "$1");
  return String(value) === written;
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
            <Checkbox checked={environments.includes(environment)} disabled={disabled} onCheckedChange={(checked) => toggle(environment, checked === true)} />
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

/** Who may call: the choice, and the header a server sends the user id in. */
export function UserSourceFields({
  draft,
  issues,
  disabled,
  onChange,
}: {
  draft: SignInDraft;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: SignInDraft) => void;
}) {
  return (
    <div className="space-y-4">
      <ChoiceList
        label="Who may call"
        choices={draft.original.type === "api_key" ? SERVER_USER_CHOICES : IOS_USER_CHOICES}
        value={draft.source}
        disabled={disabled}
        onChange={(source) => onChange({ ...draft, source })}
      />
      {draft.source === "header" ? (
        <Field label="Header name" htmlFor="end-user-header" hint="Removed before the call reaches the provider.">
          <Input
            id="end-user-header"
            value={draft.header}
            placeholder={DEFAULT_END_USER_HEADER}
            className="max-w-80 font-mono text-xs"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, header: event.target.value })}
          />
          <Problem>{issueAt(issues, "end_user.header")}</Problem>
        </Field>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Values, one input each

/**
 * A list of values, one input per value, each kept exactly as typed or
 * stored. A value with a line break is shown as it is, because a one-line
 * input would change it; it can only be removed.
 */
function ValuesEditor({
  id,
  label,
  values,
  issuePath,
  issues,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  issuePath: string;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {values.map((item, index) => {
        const multiline = /[\r\n]/u.test(item);
        const inputId = index === 0 ? id : `${id}-${index}`;
        return (
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2">
              {multiline ? (
                <div className="flex-1 space-y-0.5">
                  <pre id={inputId} aria-label={`${label} ${index + 1}`} className="rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-xs whitespace-pre-wrap">
                    {item}
                  </pre>
                  <p className="text-xs text-muted-foreground">Contains a line break, so it cannot be edited here. Edit it through the CLI or the API.</p>
                </div>
              ) : (
                <Input
                  id={inputId}
                  aria-label={index === 0 ? undefined : `${label} ${index + 1}`}
                  value={item}
                  className="font-mono text-xs"
                  autoComplete="off"
                  disabled={disabled}
                  onChange={(event) => onChange(values.map((entry, position) => (position === index ? event.target.value : entry)))}
                />
              )}
              {values.length > 1 || multiline ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(values.filter((_, position) => position !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
            <Problem>{issueAt(issues, `${issuePath}.${index}`) ?? (values.length === 1 ? issues.get(issuePath) : undefined)}</Problem>
          </div>
        );
      })}
      {values.length > 1 ? <Problem>{issues.get(issuePath)}</Problem> : null}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...values, ""])}>
        <Plus className="size-3.5" />
        Add {label.toLowerCase()}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity provider

/** Where users sign in: a provider, and the few things it needs, or every field for a custom issuer. */
export function IdentityProviderFields({
  form,
  issues,
  disabled,
  onChange,
}: {
  form: IssuerForm;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: IssuerForm) => void;
}) {
  const preset = issuerPreset(form.provider);
  const choose = (provider: IssuerProvider) => {
    if (provider === form.provider) return;
    // What this editor holds is remembered; another editor gets back what it held, or starts afresh.
    const earlier = { ...form.earlier, [form.provider]: { values: form.values, jwks_url: form.jwks_url, issuer: form.issuer, audience: form.audience } };
    const back = earlier[provider];
    const start = back ?? (provider === "custom" ? { values: {}, ...issuerFields(form) } : { values: {}, jwks_url: form.jwks_url, issuer: form.issuer, audience: form.audience });
    onChange({ ...form, provider, ...start, earlier });
  };
  const problem = issueAt(issues, "end_user.issuer.jwks_url") ?? issueAt(issues, "end_user.issuer.issuer") ?? issueAt(issues, "end_user.issuer.audience");
  return (
    <div className="space-y-4">
      <Field label="Identity provider" htmlFor="issuer-provider">
        <Select value={form.provider} disabled={disabled} onValueChange={(id) => choose(id as IssuerProvider)}>
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
      {form.provider === "custom" ? (
        <>
          <Field label="JWKS URL" htmlFor="issuer-jwks_url" hint="Where the issuer publishes its keys, over HTTPS.">
            <Input
              id="issuer-jwks_url"
              value={form.jwks_url}
              placeholder="https://issuer.example.com/.well-known/jwks.json"
              className="font-mono text-xs"
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => onChange({ ...form, jwks_url: event.target.value })}
            />
            <Problem>{issueAt(issues, "end_user.issuer.jwks_url")}</Problem>
          </Field>
          <Field label="Issuer (iss)" htmlFor="issuer-issuer" hint="Exactly as your tokens carry it, trailing slash included. With several, a token from any of them is accepted.">
            <ValuesEditor
              id="issuer-issuer"
              label="Issuer"
              values={form.issuer}
              issuePath="end_user.issuer.issuer"
              issues={issues}
              disabled={disabled}
              onChange={(issuer) => onChange({ ...form, issuer })}
            />
          </Field>
          <Field label="Audience (aud)" htmlFor="issuer-audience" hint="With several, a token for any of them is accepted.">
            <ValuesEditor
              id="issuer-audience"
              label="Audience"
              values={form.audience}
              issuePath="end_user.issuer.audience"
              issues={issues}
              disabled={disabled}
              onChange={(audience) => onChange({ ...form, audience })}
            />
          </Field>
        </>
      ) : (
        <>
          {preset.inputs.map((input) => (
            <Field key={input.key} label={input.label} htmlFor={`issuer-${input.key}`} hint={input.hint}>
              <Input
                id={`issuer-${input.key}`}
                value={form.values[input.key] ?? ""}
                placeholder={input.placeholder}
                className="font-mono text-xs"
                autoComplete="off"
                required
                disabled={disabled}
                onChange={(event) => onChange({ ...form, values: { ...form.values, [input.key]: event.target.value } })}
              />
            </Field>
          ))}
          <Problem>{issues.get("end_user.issuer.preset") ?? problem}</Problem>
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
  { value: "paid", label: "Paid users only", description: "The sign-in token must carry the claims listed below." },
];

/**
 * Whether signed-in users must also have paid, and which claims say so. Paid
 * means there is at least one claim, as the gateway checks it: choosing it
 * adds an empty claim to fill in, the last claim cannot be removed, and the
 * check is turned off only by choosing Any signed-in user. RevenueCat is a
 * helper that adds an entitlement in the shape it writes, not a mode.
 */
export function SubscriptionFields({
  form,
  issues,
  disabled,
  onChange,
}: {
  form: IssuerForm;
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: IssuerForm) => void;
}) {
  const paid = form.claims.length > 0;
  const choose = (next: Subscription) => {
    if (next === (paid ? "paid" : "any")) return;
    onChange({ ...form, claims: next === "paid" ? [newClaimRow()] : [] });
  };
  return (
    <div className="space-y-4">
      <ChoiceList label="Paid users only" choices={SUBSCRIPTION_CHOICES} value={paid ? "paid" : "any"} disabled={disabled} onChange={choose} />
      {paid ? (
        <div className="space-y-4 border-t pt-4">
          <ClaimsEditor rows={form.claims} issues={issues} disabled={disabled} onChange={(claims) => onChange({ ...form, claims })} />
        </div>
      ) : null}
    </div>
  );
}

const CLAIM_MODE_LABELS: Record<ClaimMode, string> = {
  contains: "contains",
  string: "equals text",
  number: "equals number",
  boolean: "equals true or false",
};

/**
 * A row in another match type. What it held is remembered for its type; a
 * type it held before gets its answer back; otherwise what can be carried
 * over is, and true or false starts unanswered when the value is neither.
 */
function rowIn(row: ClaimRow, mode: ClaimMode): ClaimRow {
  if (mode === row.mode) return row;
  const earlier = { ...row.earlier, [row.mode]: { values: row.values, text: row.text } };
  const back = earlier[mode];
  if (back !== undefined) return { ...row, mode, values: back.values, text: back.text, earlier };
  const carried = row.mode === "contains" ? (row.values[0] ?? "") : row.text;
  if (mode === "contains") return { ...row, mode, values: [carried], earlier };
  if (mode === "boolean") return { ...row, mode, text: carried === "true" || carried === "false" ? carried : "", earlier };
  return { ...row, mode, text: carried, earlier };
}

/** Every claim the token must carry, one row each. */
function ClaimsEditor({
  rows,
  issues,
  disabled,
  onChange,
}: {
  rows: ClaimRow[];
  issues: AuthIssues;
  disabled?: boolean;
  onChange: (next: ClaimRow[]) => void;
}) {
  const [helperNote, setHelperNote] = useState<string | null>(null);
  const replace = (index: number, row: ClaimRow) => {
    setHelperNote(null);
    onChange(rows.map((item, position) => (position === index ? row : item)));
  };
  const addRevenueCat = () => {
    // Matched as the gateway reads a path: trimmed.
    const atPath = rows.filter((row) => row.path.trim() === REVENUECAT_CLAIM_PATH);
    if (atPath.some((row) => row.mode !== "contains")) {
      // An equals rule there says something else; changing it is the person's call, made on that row.
      setHelperNote(`A rule on ${REVENUECAT_CLAIM_PATH} already compares it with equals. Change that rule to contains to list entitlements.`);
      return;
    }
    setHelperNote(null);
    // One RevenueCat row: a second entitlement is another value of it, so either admits the user.
    const index = rows.findIndex((row) => row.path.trim() === REVENUECAT_CLAIM_PATH);
    if (index !== -1) {
      onChange(rows.map((row, position) => (position === index ? { ...row, values: [...row.values, ""] } : row)));
      return;
    }
    // A claim not started yet, such as the one choosing paid users adds, becomes the RevenueCat one.
    const blank = rows.findIndex((row) => row.original === null && row.path.trim() === "" && row.mode === "contains" && row.values.every((value) => value === ""));
    if (blank !== -1) onChange(rows.map((row, position) => (position === blank ? newClaimRow(REVENUECAT_CLAIM_PATH) : row)));
    else onChange([...rows, newClaimRow(REVENUECAT_CLAIM_PATH)]);
  };
  return (
    <div className="space-y-3">
      {helperNote ? (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {helperNote}
        </p>
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Claims the sign-in token must carry, by dot path, every one of them. Contains matches lists and space-separated scopes; equals
          compares exactly.
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...rows, newClaimRow()])}>
            <Plus className="size-3.5" />
            Add claim
          </Button>
          {/* A helper, not a mode: it adds an entitlement in the shape RevenueCat's Firebase function kit writes. */}
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addRevenueCat}>
            <Plus className="size-3.5" />
            Add RevenueCat entitlement
          </Button>
        </div>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="space-y-1">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1 space-y-1.5">
              <Label htmlFor={`claim-path-${index}`} className="text-xs text-muted-foreground">
                Path
              </Label>
              <Input
                id={`claim-path-${index}`}
                value={row.path}
                placeholder="entitlements"
                className="font-mono text-xs"
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => replace(index, { ...row, path: event.target.value })}
              />
            </div>
            <div className="w-44 space-y-1.5">
              <Label htmlFor={`claim-mode-${index}`} className="text-xs text-muted-foreground">
                Match
              </Label>
              <Select value={row.mode} disabled={disabled} onValueChange={(mode) => replace(index, rowIn(row, mode as ClaimMode))}>
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
              {row.mode === "boolean" ? (
                <Select value={row.text} disabled={disabled} onValueChange={(text) => replace(index, { ...row, text })}>
                  <SelectTrigger id={`claim-value-${index}`} className="w-full">
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              ) : row.mode === "contains" ? (
                // Each value its own input, so a comma inside one stays part of it.
                <ValuesEditor
                  id={`claim-value-${index}`}
                  label="Value"
                  values={row.values}
                  issuePath={`end_user.issuer.required_claims.${index}.contains`}
                  issues={issues}
                  disabled={disabled}
                  onChange={(values) => replace(index, { ...row, values })}
                />
              ) : (
                <Input
                  id={`claim-value-${index}`}
                  value={row.text}
                  inputMode={row.mode === "number" ? "decimal" : undefined}
                  placeholder={row.mode === "number" ? "3" : "pro"}
                  className="font-mono text-xs"
                  autoComplete="off"
                  disabled={disabled}
                  onChange={(event) => replace(index, { ...row, text: event.target.value })}
                />
              )}
            </div>
            {/* The last claim stays: the paid check is turned off only by choosing Any signed-in user. */}
            {rows.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove claim ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, position) => position !== index))}
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
          {row.path.trim() === REVENUECAT_CLAIM_PATH ? (
            <p className="text-xs text-muted-foreground">
              RevenueCat entitlements: in RevenueCat under Product catalog, Entitlements, the identifier, not the display name. The values in
              this row are alternatives, so a user with any one of them is admitted; every row, though, must match. The claim is where
              RevenueCat's Firebase function kit puts it.
            </p>
          ) : null}
          <Problem>{row.mode === "contains" ? issues.get(`end_user.issuer.required_claims.${index}`) ?? issueAt(issues, `end_user.issuer.required_claims.${index}.path`) : issueAt(issues, `end_user.issuer.required_claims.${index}`)}</Problem>
        </div>
      ))}
    </div>
  );
}
