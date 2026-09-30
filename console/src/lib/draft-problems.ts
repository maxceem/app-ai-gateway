import { appConfigIssues, ConfigError, issueUnder, type ConfigIssue } from "@shared/app-config";
import { toAppWrite } from "@/lib/config-conversion";
import type { Draft } from "@/lib/app-draft";

/**
 * Where each part of the form lives in the configuration, so a section is
 * judged by the schema's own issues under its path rather than by a second copy
 * of the rules in the console.
 */
export const DRAFT_PATHS = {
  appAttest: ["authentication", "app_attest"],
  header: ["authentication", "end_user", "header"],
  issuer: ["authentication", "end_user", "issuer"],
  claims: ["authentication", "end_user", "issuer", "required_claims"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Every reason the gateway would refuse this draft's configuration, each with
 * its path. A whole-schema parse, so a form asks it once per draft and hands
 * the answer to every reader rather than each reader asking again.
 */
export function draftIssues(draft: Draft): ConfigIssue[] {
  return appConfigIssues(draft.config);
}

/** Whether no issue lies under `path`, ignoring those under `except`. */
export function clearUnder(
  issues: readonly ConfigIssue[],
  path: readonly PropertyKey[],
  except?: readonly PropertyKey[],
): boolean {
  return !issues.some((issue) => issueUnder(issue, path) && !(except && issueUnder(issue, except)));
}

/**
 * What stops the draft from being saved, in one sentence, or null when nothing
 * does, given the draft's {@link draftIssues}. The schema decides; the console
 * only words a section's refusal in the form's own terms, and says a field is
 * empty where that is all that is wrong. Saying so before the save is what
 * keeps a half-filled form from becoming a rejected request against fields the
 * operator may have scrolled away from.
 */
export function draftProblem(draft: Draft, issues: readonly ConfigIssue[]): string | null {
  if (!draft.name.trim()) return "Give the app a name.";
  // A configuration the schema has nothing against is saveable: the name is
  // the only other field, and its one refusal a form can reach is asked above.
  if (issues.length === 0) return null;
  const authentication = draft.config.authentication;
  if (authentication.type === "apple_app_attest") {
    const { team_id, bundle_id } = authentication.app_attest;
    if (!team_id.trim() || !bundle_id.trim()) return "Enter the Apple Team ID and Bundle ID.";
  }
  if (authentication.type === "api_key" && authentication.end_user.source === "header"
    && !authentication.end_user.header.trim()) {
    return "Enter the header name.";
  }
  if (!clearUnder(issues, DRAFT_PATHS.issuer, DRAFT_PATHS.claims)) {
    return "Finish the identity provider details.";
  }
  if (!clearUnder(issues, DRAFT_PATHS.claims)) return "Finish the subscription check.";
  const worded = issues.map(wordIssue).find((sentence) => sentence !== null);
  if (worded) return worded;
  // Past the form's own prompts, the schema has the last word, and its message
  // names the field at fault.
  try {
    toAppWrite(draft);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return null;
}

const SCOPE_LABELS: Record<string, string> = { per_user: "Per-user", per_app: "Per-app" };

/**
 * A schema issue in the words of the form that made it, or null for one the
 * form has no better words for than the schema's own. Every sentence names
 * the field by its label and the row by the slug the operator gave it, so a
 * refused save says where to go rather than where the value lives.
 */
export function wordIssue(issue: ConfigIssue): string | null {
  const [section, ...rest] = issue.path.map(String);

  if (section === "routing" && rest[0] === "providers" && rest[1] === "selected" && rest[2]) {
    const slug = rest[2];
    switch (rest[3]) {
      case "allowed_paths":
        return rest[5] === "fixed_model"
          ? `Enter the fixed model for ${slug}, or leave it empty.`
          : `Enter the endpoint path for ${slug}.`;
      case "allowed_models":
        return `Enter the model name for ${slug}.`;
      case "max_output_tokens":
        return `Max output tokens for ${slug} must be a whole number above 0.`;
      default:
        return null;
    }
  }
  if (section === "routing" && rest[0] === "model_rewrites") {
    return "Fill in both sides of every model rewrite.";
  }

  if (section === "limits" && rest[0] && SCOPE_LABELS[rest[0]]) {
    const scope = SCOPE_LABELS[rest[0]];
    switch (rest[2]) {
      case "per_minute":
        return `${scope} requests per minute must be a whole number above 0.`;
      case "per_day":
        return `${scope} requests per day must be a whole number above 0.`;
      case "monthly_usd":
        return issue.message.includes("too large")
          ? `${scope} monthly spending budget is too large.`
          : `${scope} monthly spending budget must be 0 or more.`;
      default:
        return null;
    }
  }

  if (section === "endpoints" && rest[0] !== undefined) {
    const slug = rest[0];
    const name = `the custom endpoint ${slug || "with no slug"}`;
    if (rest.length === 1) {
      return `The custom endpoint slug "${slug}" is not valid: use 1-64 characters from a-z, 0-9 and -.`;
    }
    switch (rest[1]) {
      case "provider":
        return `Choose a provider for ${name}.`;
      case "model":
        return `Choose a model for ${name}.`;
      case "max_output_tokens":
        return `Max output tokens for ${name} must be a whole number above 0.`;
      case "params":
        return `Parameters for ${name} must be a JSON object.`;
      case "fallback":
        return rest[3] === "model"
          ? `Choose a model for fallback ${Number(rest[2]) + 1} of ${name}.`
          : `Choose a provider for fallback ${Number(rest[2]) + 1} of ${name}.`;
      default:
        return null;
    }
  }

  return null;
}
