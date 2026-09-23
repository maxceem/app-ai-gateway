import { appleIdentityProblem, ConfigError } from "@shared/app-config";
import { toAppWrite } from "@/lib/config-conversion";
import type { Draft } from "@/lib/app-draft";
import { authIssuer, type AuthConfig, type ClaimRequirement } from "@/lib/config-types";

/** Whether the three fields that scope an issuer to one tenant are all there. */
export function issuerComplete(issuer: AuthConfig): boolean {
  const present = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value.length > 0 && value.every(Boolean) : Boolean(value);
  return (issuer.jwks_url ?? "").startsWith("https://") && present(issuer.issuer) && present(issuer.audience);
}

/** Whether a claim requirement names a path and something to match it against. */
export function claimComplete(claim: ClaimRequirement): boolean {
  if (!claim.path.trim()) return false;
  if (claim.equals !== undefined) return String(claim.equals).length > 0;
  return Array.isArray(claim.contains)
    ? claim.contains.length > 0 && claim.contains.every((value) => value.trim().length > 0)
    : Boolean(claim.contains?.trim());
}

/**
 * What stops the draft from being saved, in one sentence, or null when
 * nothing does. The Worker would refuse each of these anyway; saying so before
 * the save is what keeps a half-filled form from becoming a rejected request
 * against fields the operator may have scrolled away from.
 */
export function draftProblem(draft: Draft): string | null {
  const authentication = draft.config.authentication;
  if (!draft.name.trim()) return "Give the app a name.";
  if (authentication.type === "apple_app_attest") {
    const { team_id, bundle_id } = authentication.app_attest;
    if (!team_id.trim() || !bundle_id.trim()) return "Enter the Apple Team ID and Bundle ID.";
    const identity = appleIdentityProblem({ team_id, bundle_id });
    if (identity) return identity;
  }
  if (authentication.type === "api_key" && authentication.end_user?.source === "header") {
    if (!authentication.end_user.header.trim()) return "Enter the header name.";
  }
  const issuer = authIssuer(authentication);
  if (issuer) {
    if (!issuerComplete(issuer)) return "Finish the identity provider details.";
    if (!(issuer.required_claims ?? []).every(claimComplete)) return "Finish the subscription check.";
  }
  // Everything above names a field left empty, in the form's own words. The
  // last word is the schema's: a draft it would refuse is not saveable, and
  // its message names the field at fault.
  try {
    toAppWrite(draft);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return null;
}
