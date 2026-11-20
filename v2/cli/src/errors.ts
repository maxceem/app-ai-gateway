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
});
export type CliErrorDetails = z.infer<typeof CliErrorDetailsSchema>;

