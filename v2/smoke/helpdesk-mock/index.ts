/**
 * A mock of the help desk, for the v2 test deployment only, through a
 * `HelpdeskWorker` entrypoint, as the real help desk Worker is bound
 * (`src/helpdesk/contract.ts`). It keeps no ticket and calls no help desk.
 *
 * Like the real one, it refuses another service's ticket, a message that looks
 * like it carries a credential and a page that is not an http(s) URL, and
 * emails the person their reference with a copy to the support inbox. The
 * email goes through its own `EMAIL` binding, the mail mock
 * (`smoke/mail-mock/`), which sends nothing and keeps mail only for
 * `example.test` addresses: so a ticket for any other address is opened but
 * not delivered, and nobody is ever emailed.
 *
 * Deploy: `pnpm exec wrangler deploy -c smoke/helpdesk-mock/wrangler.jsonc`.
 * The test deployment binds it as HELPDESK (gitignored wrangler.test.jsonc).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { HelpdeskTicketInput, HelpdeskTicketResult } from "../../src/helpdesk/contract.ts";

interface HelpdeskEnv {
  /** The mail mock's `send`. */
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
  /** The inbox a copy goes to: an `example.test` address. */
  SUPPORT_INBOX?: string;
}

/** The only service this mock opens tickets for: the gateway's id (`HELPDESK_SERVICE_ID`). */
export const SERVICE_ID = "app-ai-gateway";

const TOPICS: Record<HelpdeskTicketInput["kind"], string> = { bug: "Bug report", support: "Support request", feedback: "Feedback" };

/** What a pasted credential looks like: a provider or gateway key prefix with a long tail. */
const CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{16,}|agw_[A-Za-z0-9_]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/u;

/** A reference like `SUP-7F3K2Q`: six characters a person can read aloud. */
export function newReference(random: Uint8Array = crypto.getRandomValues(new Uint8Array(6))): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `SUP-${[...random].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** The mock's judgement of a ticket, before anything is sent: a refusal, or null to open it. */
export function refusal(input: HelpdeskTicketInput): (HelpdeskTicketResult & { ok: false }) | null {
  if (input.serviceId !== SERVICE_ID) return { ok: false, code: "unknown_service", message: "Unknown service." };
  const texts = [input.message, ...Object.values(input.context ?? {})];
  if (texts.some((text) => CREDENTIAL.test(text))) {
    return { ok: false, code: "credential_detected", message: "The message looks like it contains a key or token. Remove it and send again." };
  }
  if (input.page !== undefined) {
    let url: URL | null = null;
    try {
      url = new URL(input.page);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return { ok: false, code: "invalid_input", message: "page: Invalid URL" };
  }
  return null;
}

export class HelpdeskWorker extends WorkerEntrypoint<HelpdeskEnv> {
  async createTicket(input: HelpdeskTicketInput): Promise<HelpdeskTicketResult> {
    const refused = refusal(input);
    if (refused !== null) return refused;
    const reference = newReference();
    const subject = `[${reference}] ${TOPICS[input.kind] ?? "Support request"}`;
    const text = [`Your message to support, ${reference}:`, "", input.message, "", "Reply to this email to add to it."].join("\n");
    let delivered = false;
    const email = this.env.EMAIL;
    if (email !== undefined) {
      // The mail mock refuses any address outside example.test: such a ticket is opened, not delivered.
      for (const to of [input.customer.email, this.env.SUPPORT_INBOX]) {
        if (to === undefined) continue;
        try {
          await email.send({ to, from: "support@example.test", subject, text });
          if (to === input.customer.email) delivered = true;
        } catch {
          // Not a test address.
        }
      }
    }
    return { ok: true, reference, duplicate: false, delivered, replyTo: input.customer.email };
  }
}

export default {
  fetch(): Response {
    return new Response("Help desk mock: bound as HELPDESK, not served over HTTP.\n", { status: 404 });
  },
};
