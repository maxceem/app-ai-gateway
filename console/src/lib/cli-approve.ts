/**
 * How a CLI browser handoff is worded, away from the page that renders it.
 *
 * Both answers are derived rather than listed: a handoff kind added to the
 * contract still gets a heading, and an account id is shortened by the same
 * rule wherever it is shown.
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
