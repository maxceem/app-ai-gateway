/**
 * A stand-in for the gateway's email sender, for the v2 test deployment only.
 * It sends nothing anywhere: the test deployment binds its `MailMock`
 * entrypoint as `EMAIL`, the same `send` as Cloudflare Email Service, and the
 * mock keeps each message for an hour, so the email smoke check can read the
 * verification link back.
 *
 * Only addresses at `example.test` (a name that can never receive mail) are
 * kept; anything else is refused, so a real address never lands here. A
 * message is read by its exact recipient, `GET /outbox?to=<address>`; a
 * smoke check signs up with a random address, so nobody else can guess it.
 *
 * Deploy: `pnpm exec wrangler deploy -c smoke/mail-mock/wrangler.jsonc`.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface MailEnv {
  OUTBOX: DurableObjectNamespace<Outbox>;
}

/** What a message keeps: only what a check reads. */
export interface KeptMessage {
  subject: string;
  text: string;
}

/** The domain every kept address is at. */
export const TEST_DOMAIN = "@example.test";

const KEEP_MS = 3_600_000;
const KEEP_MESSAGES = 5;

/** The messages one address was sent, newest last. */
export class Outbox extends DurableObject<MailEnv> {
  async keep(message: KeptMessage): Promise<void> {
    const kept = (await this.ctx.storage.get<KeptMessage[]>("messages")) ?? [];
    await this.ctx.storage.put("messages", [...kept, message].slice(-KEEP_MESSAGES));
    await this.ctx.storage.setAlarm(Date.now() + KEEP_MS);
  }

  async list(): Promise<KeptMessage[]> {
    return (await this.ctx.storage.get<KeptMessage[]>("messages")) ?? [];
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/** Whether a recipient is one this mock keeps mail for. */
export function testAddress(to: unknown): to is string {
  return typeof to === "string" && to.length <= 254 && to.toLowerCase().endsWith(TEST_DOMAIN) && !/[\s<>]/u.test(to);
}

/** The binding the gateway sends with: Cloudflare Email Service's `send`. */
export class MailMock extends WorkerEntrypoint<MailEnv> {
  async send(message: { to?: unknown; subject?: unknown; text?: unknown }): Promise<{ messageId: string }> {
    if (!testAddress(message.to)) throw new Error("The mail mock keeps mail only for example.test addresses");
    await this.env.OUTBOX.getByName(message.to.toLowerCase()).keep({
      subject: typeof message.subject === "string" ? message.subject : "",
      text: typeof message.text === "string" ? message.text : "",
    });
    return { messageId: crypto.randomUUID() };
  }
}

export default {
  async fetch(request: Request, env: MailEnv): Promise<Response> {
    const url = new URL(request.url);
    const to = url.searchParams.get("to");
    if (request.method !== "GET" || url.pathname !== "/outbox" || !testAddress(to)) {
      return new Response("Mail mock: GET /outbox?to=<address at example.test>\n", { status: 404 });
    }
    const messages = await env.OUTBOX.getByName(to.toLowerCase()).list();
    return Response.json({ messages }, { headers: { "cache-control": "no-store" } });
  },
};
