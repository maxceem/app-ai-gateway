import type { Context } from "hono";
import {
  prepareResourceReceipt,
  type ResourceReceipt,
} from "../../management/resource-receipt";
import type { AdminVariables } from "../../middleware/admin";

type ReceiptContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

/**
 * Runs a creation under the request's retry receipt, if it sent one.
 *
 * The dance is always the same and was written out four times, in two shapes:
 * prepare the receipt from the `Idempotency-Key` and `X-Idempotency-Proof`
 * headers; answer from it if this request already committed; otherwise run the
 * write with the receipt as its transaction boundary, and prefer whatever the
 * receipt recorded to what this attempt computed, since a concurrent twin may
 * have won it. A failure is one last question to the receipt: if the write
 * landed and only the answer was lost, the recorded answer is sent again
 * rather than the error.
 */
export async function receipted<T extends Record<string, unknown>>(
  c: ReceiptContext,
  kind: string,
  body: unknown,
  write: (boundary: ResourceReceipt | undefined) => Promise<T>,
): Promise<T> {
  const receipt = await prepareResourceReceipt({
    env: c.env,
    actor: c.get("actor"),
    kind,
    method: c.req.method,
    path: c.req.path,
    body,
    idempotencyKey: c.req.header("Idempotency-Key"),
    proof: c.req.header("X-Idempotency-Proof"),
  });
  if (receipt?.result) return receipt.result as T;
  try {
    const outcome = await write(receipt);
    return (receipt?.result ?? outcome) as T;
  } catch (error) {
    if (receipt && (await receipt.read())) return receipt.result as T;
    throw error;
  }
}
