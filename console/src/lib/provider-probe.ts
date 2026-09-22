/**
 * What a dry run of a credential means, in the operator's own terms.
 *
 * The gateway answers a probe with what happened — validated, or a reason and a
 * status. Turning that into a verdict is a reading, not a fact, and it is the
 * same reading in every dialog that offers a Test button, so it lives here
 * rather than beside any one of them.
 */

import { PROVIDER_LABELS, type Provider } from "@/lib/config-types";
import type { ProviderTestResult } from "@/lib/types";

/**
 * What a dry run of a credential can say. "Unconfirmed" is its own answer, not
 * a failure: a provider outage, or a provider with no probe of its own, proves
 * nothing about a key the operator may well know is right.
 */
export type TestOutcome = {
  status: "works" | "unconfirmed" | "failed";
  message: string;
};

/**
 * A refusal the operator can act on, as opposed to a check that could not be
 * made. 5xx and 429 are the upstream having a moment and say nothing about the
 * credential; every other status means something rejected the request.
 */
export function isRefusal(result: ProviderTestResult): boolean {
  return (
    result.reason === "unexpected_status"
    && result.status !== undefined
    && result.status < 500
    && result.status !== 429
  );
}

/**
 * Says what stopped the check rather than that it was inconclusive.
 *
 * A gateway that holds no key for this provider, or a wrong gateway id, answers
 * with a status of its own — naming it is the difference between an operator
 * knowing where to look and being told nothing at all.
 */
export function testMessage(
  result: ProviderTestResult,
  type: Provider,
  viaGateway: boolean,
): string {
  const label = PROVIDER_LABELS[type];
  const responder = viaGateway ? "The gateway" : label;
  switch (result.reason) {
    case "no_probe":
      return `There is no test call for ${label}, so nothing was checked. Add it if you know it is right.`;
    case "unreachable":
      return `${responder} did not answer in time, so nothing is proven either way.`;
    case "unexpected_status":
      if (!isRefusal(result)) {
        return `${responder} answered with HTTP ${result.status}, so nothing is proven either way.`;
      }
      return viaGateway
        ? `The gateway answered with HTTP ${result.status}. Check that it holds a stored key for ${label}.`
        : `${label} answered with HTTP ${result.status}, so this key could not be used.`;
    default:
      return "Nothing is proven either way. Add it if you know it is right.";
  }
}

/** The verdict, with a refusal shown as the error it is. */
export function testOutcome(
  result: ProviderTestResult,
  type: Provider,
  viaGateway: boolean,
): TestOutcome {
  if (result.validated) {
    return { status: "works", message: "Works. The provider accepted this credential." };
  }
  const message = testMessage(result, type, viaGateway);
  return isRefusal(result) ? { status: "failed", message } : { status: "unconfirmed", message };
}

/**
 * The verdict on a gateway connection, which is nobody's credential but the
 * gateway's own.
 *
 * A refusal names both things it can mean, because the console cannot tell them
 * apart and the operator can: the token is wrong, or the gateway is not
 * finished being set up. Neither stops the connection being saved.
 */
export function gatewayOutcome(result: ProviderTestResult): TestOutcome {
  if (result.validated) {
    return { status: "works", message: "Works. The gateway accepted this token." };
  }
  if (result.reason === "rejected") {
    return {
      status: "failed",
      message: `The gateway refused this token (HTTP ${result.status}). Check the token itself, that authentication is turned on, and that the gateway holds a key for OpenAI.`,
    };
  }
  if (result.reason === "unreachable") {
    return {
      status: "unconfirmed",
      message: "The gateway did not answer in time, so nothing is proven either way.",
    };
  }
  const message = result.reason === "unexpected_status"
    ? `The gateway answered with HTTP ${result.status}. Check the account and gateway IDs.`
    : "Nothing is proven either way. Add it if you know it is right.";
  return { status: isRefusal(result) ? "failed" : "unconfirmed", message };
}
