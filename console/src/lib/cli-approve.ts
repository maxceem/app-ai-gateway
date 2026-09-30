/**
 * How a CLI browser handoff is worded, away from the page that renders it.
 *
 * The answers are derived rather than listed: a handoff kind added to the
 * contract still gets a heading, an account id is shortened by the same rule
 * wherever it is shown, and a typed pairing code is read the way the gateway
 * reads it.
 */

import type { CliOperationKind } from "@contracts/cli";

/**
 * What the heading says this handoff does.
 *
 * Derived from the kind rather than listed exhaustively, so a handoff kind
 * added to the contract still gets a sentence rather than a blank card.
 */
export function headingFor(kind: CliOperationKind | string): string {
  if (kind === "claim") return "Claim your account";
  if (kind === "login") return "Connect the agw CLI";
  const [subject, action] = kind.split(".");
  const noun = subject === "provider-gateway" ? "provider gateway" : "provider";
  if (action === "add") return `Add a ${noun}`;
  if (action === "rotate-key") return `Rotate the ${noun} credential`;
  if (action === "update") return `Update the ${noun}`;
  return `Approve a ${noun} change`;
}

/** Enough of an account id to compare with the terminal, not enough to read aloud. */
export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/**
 * A typed pairing code as the terminal prints it, `ABCD-EFGH`, or null when it
 * cannot be one.
 *
 * Case, spaces and the dash are ignored, which is also what the gateway
 * ignores, so whatever a person copies out of their terminal is accepted.
 */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/gu, "");
  if (!/^[A-Z0-9]{8}$/u.test(code)) return null;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What the code-entry page hands the approval page: the pairing code, which is
 * then the page's submission token in place of a link's fragment proof. Carried
 * in navigation state, so it is never part of a URL.
 */
export interface ApproveNavigationState {
  userCode: string;
}

export function approvePathFor(id: string): string {
  return `/cli/approve/${encodeURIComponent(id)}`;
}

/** The pairing code in a navigation's state, when the code-entry page sent it. */
export function userCodeFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const code = (state as Partial<ApproveNavigationState>).userCode;
  return typeof code === "string" && normalizeUserCode(code) !== null ? code : null;
}
