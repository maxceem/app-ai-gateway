/**
 * A mock of the help desk, for the v2 test deployment only, through a
 * `HelpdeskWorker` entrypoint, as the real help desk Worker is bound
 * (`src/helpdesk/contract.ts`). It keeps no ticket and calls no help desk.
 *
 * It opens every ticket with a new reference and emails the person that
 * reference. It sends no copy to any shared inbox: only the sender's own
 * address, through its own `EMAIL` binding, the mail mock
 * (`smoke/mail-mock/`), which sends nothing and keeps mail only for
 * `example.test` addresses. A ticket for any other address is opened but not
 * delivered, and nobody is ever emailed.
 *
 * Deploy: `pnpm exec wrangler deploy -c smoke/helpdesk-mock/wrangler.jsonc`.
 * The test deployment binds it as HELPDESK (gitignored wrangler.test.jsonc).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { SUPPORT_TOPICS } from "../../src/contracts/support.ts";
import type { HelpdeskTicketInput, HelpdeskTicketResult } from "../../src/helpdesk/contract.ts";

interface HelpdeskEnv {
  /** The mail mock's `send`. */
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown> };
}

/** A reference like `SUP-7F3K2Q`: six characters a person can read aloud. */
function newReference(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `SUP-${[...crypto.getRandomValues(new Uint8Array(6))].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}

export class HelpdeskWorker extends WorkerEntrypoint<HelpdeskEnv> {
  async createTicket(input: HelpdeskTicketInput): Promise<HelpdeskTicketResult> {
    const reference = newReference();
    const subject = `[${reference}] ${SUPPORT_TOPICS[input.kind] ?? "Support request"}`;
    const text = [`Your message to support, ${reference}:`, "", input.message, "", "Reply to this email to add to it."].join("\n");
    let delivered = false;
    // Only the sender's own address: the mail mock refuses any outside example.test, so such a ticket is opened, not delivered.
    if (this.env.EMAIL !== undefined) {
      try {
        await this.env.EMAIL.send({ to: input.customer.email, from: "support@example.test", subject, text });
        delivered = true;
      } catch {
        delivered = false;
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
