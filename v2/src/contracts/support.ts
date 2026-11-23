/**
 * A message to the deployment's human support (v1's, ported): from the
 * console's Support menu, `agw support send` and the MCP `contact_support`
 * tool alike. Plain `zod`, so the console and the CLI import it.
 */
import { z } from "zod";
import { ConsoleReturnPathSchema } from "./access.ts";

export const SUPPORT_KINDS = ["bug", "support", "feedback"] as const;
export const SupportMessageKindSchema = z.enum(SUPPORT_KINDS);
export type SupportMessageKind = z.infer<typeof SupportMessageKindSchema>;

/**
 * Each kind's topic, which is the email's subject: the message alone is what a
 * person writes, so the subject is never theirs to fill in.
 */
export const SUPPORT_TOPICS: Readonly<Record<SupportMessageKind, string>> = {
  bug: "Bug report",
  support: "Support request",
  feedback: "Feedback",
};

/** The longest message support takes. */
export const SUPPORT_MESSAGE_MAX = 10_000;

/** A diagnostic an agent attaches: a short name, and a short value. */
const SUPPORT_CONTEXT_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/u;

/** A message to the deployment's support inbox, from the person the credential belongs to. */
export const SupportMessageRequestSchema = z
  .object({
    kind: SupportMessageKindSchema,
    message: z.string().trim().min(1, "Write a message").max(SUPPORT_MESSAGE_MAX).meta({
      description: "What the person wants support to know, in their words. Never include a key, token or password.",
    }),
    /** The console page the message was written from, for context. */
    page: ConsoleReturnPathSchema.optional(),
    context: z
      .record(
        z.string().regex(SUPPORT_CONTEXT_KEY, "Context names are letters, digits, _ . and -, up to 40 characters"),
        z.string().trim().min(1).max(500),
      )
      .refine((value) => Object.keys(value).length <= 20, "At most 20 context entries")
      .optional()
      .meta({
        description: "Facts that help support act without asking back, such as app_id, request_id, error_code or agw_version. Never a credential.",
      }),
    client: z.string().trim().min(1).max(100).optional().meta({
      description: "What sent the message, such as `agw 2.0.0`, as the client reports it. A label only.",
    }),
  })
  .strict()
  .meta({ id: "SupportMessageRequest" });

export type SupportMessageRequest = z.infer<typeof SupportMessageRequestSchema>;

export const SupportMessageResponseSchema = z
  .object({
    status: z.literal("sent"),
    reference: z.string().meta({
      description: "The request's reference, such as SUP-7F3K2Q, in the email's subject too. Quote it when following up.",
    }),
    replyTo: z.string().meta({ description: "The address support will reply to: the sender's own." }),
    duplicate: z.boolean().meta({
      description: "True when the same message was sent in the last ten minutes: nothing new was sent, and reference is the earlier one's.",
    }),
  })
  .meta({ id: "SupportMessageResponse" });
