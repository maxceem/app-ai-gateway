import { appConfigIssues, ConfigError, issueUnder, type ConfigIssue } from "@shared/app-config";
import { materializeAppConfigDraft, toAppWrite } from "@/lib/config-conversion";
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

/** Every reason the gateway would refuse this draft's configuration, each with its path. */
export function draftIssues(draft: Draft): ConfigIssue[] {
  return appConfigIssues(materializeAppConfigDraft(draft.config));
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
 * does. The schema decides; the console only words a section's refusal in the
 * form's own terms, and says a field is empty where that is all that is wrong.
 * Saying so before the save is what keeps a half-filled form from becoming a
 * rejected request against fields the operator may have scrolled away from.
 */
export function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the app a name.";
  const authentication = draft.config.authentication;
  const issues = draftIssues(draft);
  if (authentication.type === "apple_app_attest") {
    const { team_id, bundle_id } = authentication.app_attest;
    if (!team_id.trim() || !bundle_id.trim()) return "Enter the Apple Team ID and Bundle ID.";
  }
  if (authentication.type === "api_key" && authentication.end_user?.source === "header"
    && !authentication.end_user.header.trim()) {
    return "Enter the header name.";
  }
  if (!clearUnder(issues, DRAFT_PATHS.issuer, DRAFT_PATHS.claims)) {
    return "Finish the identity provider details.";
  }
  if (!clearUnder(issues, DRAFT_PATHS.claims)) return "Finish the subscription check.";
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
