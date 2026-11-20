import { z } from "zod";

/**
 * The `details` of the envelope the CLI prints for a failure; see `CliError`
 * in `./common.ts`. The CLI's own output, not a wire contract.
 */
export const CliErrorDetailsSchema = z.object({
  status: z.number().optional(),
  appId: z.string().optional(),
  keyId: z.string().optional(),
  providerId: z.string().optional(),
  providerGatewayId: z.string().optional(),
  revoked: z.boolean().optional(),
  storagePath: z.string().optional(),
  /** Which ceiling refused the request, for the codes that name one. */
  scope: z.string().optional(),
  limit: z.number().optional(),
  used: z.number().optional(),
  windowSeconds: z.number().optional(),
  retryAfterSeconds: z.number().optional(),
  resetAt: z.string().optional(),
  id: z.string().optional(),
  state: z.string().optional(),
  expiresAt: z.string().optional(),
  url: z.string().optional(),
  /** The tail of a failed subprocess's own output, for failures it explains. */
  output: z.string().optional(),
  /**
   * What Cloudflare itself said about a refused API call: each error's message
   * and its code. Carried because the things that refuse a deployment — an
   * account ceiling, a permission a token lacks — are named only there, and
   * wrangler reports an API refusal it aggregates as the bare sentence that a
   * request failed.
   */
  apiErrors: z.string().optional(),
});
export type CliErrorDetails = z.infer<typeof CliErrorDetailsSchema>;

