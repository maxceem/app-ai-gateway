/**
 * The writes an agent hands to a person (v1's browser steps and reserved
 * creates, ported):
 *
 * - **Browser steps.** Adding a provider connection, or replacing its key,
 *   opens an operation with what can be reviewed and answers a console link.
 *   A person opens it, enters the key there and approves. The key never
 *   passes through the agent.
 * - **Reserved creates.** Creating an app or an app key takes two calls: one
 *   without `handle` reserves it and creates nothing, one with the `handle`
 *   creates it, once. A key it creates is never in the answer: a person
 *   signed in to the console reveals it once, on the page `reveal_url` names.
 * - **Operations.** Where any of these stands, for any credential of the
 *   account, and the one place a created key is handed to a person.
 */
import { z } from "zod";
import {
  APP_STATUSES,
  AppNameSchema,
  AppSchema,
  CreatedAppKeySchema,
  ProviderCreateRequestSchema,
  ProviderSchema,
  SecretSchema,
} from "./admin.ts";

/** Adding a provider connection: everything `createProvider` takes but the key. */
export const ProviderHandoffRequestSchema = ProviderCreateRequestSchema.omit({ secret: true })
  .strict()
  .meta({ id: "ProviderHandoffRequest" });

/** Replacing a connection's key: the revision it was read at. */
export const ProviderKeyHandoffRequestSchema = z
  .object({ revision: z.number().int().positive() })
  .strict()
  .meta({ id: "ProviderKeyHandoffRequest" });

/** A browser step an agent opened: the link a person approves it on. */
export const OpenedHandoffResponseSchema = z
  .object({
    /** The operation's id, which `getOperation` reads. */
    id: z.string(),
    kind: z.enum(["provider.add", "provider.rotate-key"]),
    /** The console page where a person enters the key and approves. Give it to the person; never open it yourself. */
    url: z.string(),
    expiresAt: z.string(),
    /** Set when an identical request was made in the last hour: inspect that operation before creating another. */
    notice: z.string().optional(),
  })
  .meta({ id: "OpenedHandoffResponse" });

/** A reservation's handle: what the second call takes. */
export const ReservationHandleSchema = z.string().min(1).max(512);

export const ReservedAppRequestSchema = z
  .object({
    name: AppNameSchema,
    config: z.unknown(),
    status: z.enum(APP_STATUSES).optional(),
    /** Leave it out to reserve; send the answer's `handle` to create, once. */
    handle: ReservationHandleSchema.optional(),
  })
  .strict()
  .meta({ id: "ReservedAppRequest" });

export const ReservedAppKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    handle: ReservationHandleSchema.optional(),
  })
  .strict()
  .meta({ id: "ReservedAppKeyRequest" });

/** What a reservation answers: nothing is created yet. */
export const ReservationSchema = z
  .object({
    state: z.literal("reserved"),
    /** What the second call takes. Not an operation id. */
    handle: z.string(),
    /** The operation's id, which `getOperation` reads. */
    id: z.string(),
    expiresAt: z.string(),
    notice: z.string().optional(),
  })
  .meta({ id: "Reservation" });

/** A created key, without its value. */
export const AppKeyMetadataSchema = CreatedAppKeySchema.omit({ key: true }).meta({ id: "AppKeyMetadata" });

export const ReservedAppResponseSchema = z
  .discriminatedUnion("state", [
    ReservationSchema,
    z.object({
      state: z.literal("created"),
      /** The operation's id. */
      id: z.string(),
      /** True when this answer repeats the call that created it: nothing new was created. */
      replayed: z.boolean(),
      app: AppSchema,
      /** The first key of an app-key app, without its value. Null for an App Attest app. */
      api_key: AppKeyMetadataSchema.nullable(),
      /** Where a person signed in as an owner or admin sees the key once, while it can still be revealed. */
      reveal_url: z.string().optional(),
    }),
  ])
  .meta({ id: "ReservedAppResponse" });

export const ReservedAppKeyResponseSchema = z
  .discriminatedUnion("state", [
    ReservationSchema,
    z.object({
      state: z.literal("created"),
      id: z.string(),
      replayed: z.boolean(),
      app_id: z.string(),
      api_key: AppKeyMetadataSchema,
      reveal_url: z.string().optional(),
    }),
  ])
  .meta({ id: "ReservedAppKeyResponse" });

/** What a completed operation created, never a key's value. */
export const OperationResultSchema = z
  .object({
    app: AppSchema.optional(),
    app_id: z.string().optional(),
    api_key: AppKeyMetadataSchema.nullable().optional(),
    provider: ProviderSchema.optional(),
  })
  .meta({ id: "OperationResult" });

export const OperationStatusResponseSchema = z
  .object({
    id: z.string(),
    /** The engine's kind, such as `provider.add.browser` or `app.add.reserved`. */
    kind: z.string(),
    state: z.enum(["pending", "completed", "expired"]),
    /** Set on an expired one a person declined. */
    denied: z.literal(true).optional(),
    createdAt: z.string(),
    expiresAt: z.string(),
    result: OperationResultSchema.optional(),
    /** While a key it created can still be revealed: the page where a person sees it once. */
    reveal_url: z.string().optional(),
  })
  .meta({ id: "OperationStatusResponse" });

export const RevealedOperationResponseSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    result: z.object({
      app: AppSchema.optional(),
      app_id: z.string().optional(),
      /** The key, with its value, shown this once. */
      api_key: CreatedAppKeySchema,
    }),
  })
  .meta({ id: "RevealedOperationResponse" });

// ---------------------------------------------------------------------------
// The console's approval page

/** The proof from the approval link's fragment. */
export const HandoffProofSchema = z.object({ proof: z.string().min(16).max(512) }).strict();

export const HandoffSubmitRequestSchema = z
  .object({
    proof: z.string().min(16).max(512),
    /** The key the person entered. Never stored as given and never answered. */
    secret: SecretSchema.refine((value) => /\S/u.test(value), { error: "secret must not be blank" }),
  })
  .strict();

export const HandoffDetailsResponseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["provider.add", "provider.rotate-key"]),
    state: z.enum(["pending", "completed", "denied", "expired", "retired"]),
    expiresAt: z.string(),
    /** What the person approves: the connection to add, or the one whose key is replaced. */
    review: z.object({
      type: z.string(),
      name: z.string(),
      slug: z.string(),
      baseUrl: z.string().nullable(),
      /** For a key replacement: the last characters of the key it replaces. */
      secretHint: z.string().nullable().optional(),
    }),
  })
  .meta({ id: "HandoffDetailsResponse" });

export const HandoffAnswerResponseSchema = z
  .object({ state: z.enum(["completed", "denied"]) })
  .meta({ id: "HandoffAnswerResponse" });
