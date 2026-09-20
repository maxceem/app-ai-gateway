import type { Context } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { prepareResourceReceipt as prepareManagementReceipt } from "../../management/resource-receipt";

type ReceiptContext = Context<{ Bindings: Env; Variables: AdminVariables }>;

export function prepareResourceReceipt(c: ReceiptContext, kind: string, body: unknown) {
  const admin = c.get("admin");
  return prepareManagementReceipt({
    env: c.env,
    actor: {
      organizationId: admin.organizationId,
      userId: admin.userId,
      credentialId: admin.credentialId,
    },
    kind,
    method: c.req.method,
    path: c.req.path,
    body,
    idempotencyKey: c.req.header("Idempotency-Key"),
    proof: c.req.header("X-Idempotency-Proof"),
  });
}
