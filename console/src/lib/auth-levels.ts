/**
 * Where an application's authentication policy stands, read off its draft.
 *
 * The policy is a ladder of three decisions — how the app proves itself, then
 * whether its users must be signed in, then whether they must have paid — and
 * each rung has a standing that is derived, never stored. Deriving it is a
 * reading of the configuration rather than a piece of the screen, so it lives
 * here and the Auth policy tab renders what it returns.
 */

import { appleIdentityProblem } from "@shared/app-config";
import type { Draft } from "@/lib/app-draft";
import { authIssuer, type AuthConfig } from "@/lib/config-types";
import { claimComplete, issuerComplete } from "@/lib/draft-problems";
import type { UserSource } from "@/lib/user-sources";

export type AuthLevel = "identity" | "users" | "subscription";

export const DEFAULT_AUTH_LEVEL: AuthLevel = "identity";

/**
 * How a level stands, read off the draft. `secure` is the strictest answer
 * the level offers; `weak` is a deliberate looser one; `incomplete` means the
 * answer given still lacks something the gateway needs; `off` means the level
 * does not apply until a level above changes.
 */
export interface LevelStatus {
  tone: "secure" | "weak" | "incomplete" | "off";
  text: string;
}

export type Subscription = "paid" | "any";

export const subscriptionOf = (issuer: AuthConfig): Subscription =>
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
        : appleIdentityProblem(authentication.app_attest)
          ? { tone: "incomplete", text: "Team or bundle id invalid" }
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
