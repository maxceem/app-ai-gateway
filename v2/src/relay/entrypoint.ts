/**
 * The entrypoint the relay is bound to (`MAIN`, plan section 5.1). Its
 * methods load their code on first use, so a proxied request's cold start
 * does not pay for it. A refusal reaches the relay as an error whose message
 * is a code (`./contract.ts`).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { CloseInput } from "./contract.ts";
import type { CheckpointInput } from "./checkpoint.ts";

export class RelayContract extends WorkerEntrypoint<Env> {
  async open(ticket: string) {
    const { openForRelay } = await import("./contract.ts");
    return await openForRelay(this.env, ticket, Date.now(), (promise) => this.ctx.waitUntil(promise));
  }

  async checkpoint(ticket: string, input: CheckpointInput) {
    const { checkpointForRelay } = await import("./checkpoint.ts");
    return await checkpointForRelay(this.env, ticket, input, Date.now(), (promise) => this.ctx.waitUntil(promise));
  }

  async close(ticket: string, input: CloseInput) {
    const { closeForRelay } = await import("./contract.ts");
    return await closeForRelay(this.env, ticket, input, Date.now(), (promise) => this.ctx.waitUntil(promise));
  }
}
