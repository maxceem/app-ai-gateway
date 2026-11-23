/**
 * Request and response shapes for sign-in and access: the caller's own
 * session and accounts, management keys and OAuth sign-ins (CLI logins and
 * MCP connections), and the console's pages for OAuth consent and for
 * entering a device code. Plain `zod`, so the console and the CLI can import it.
 */
import { z } from "zod";
import { SessionBillingSchema } from "./billing.ts";

export const ACCOUNT_ROLES = ["owner", "admin", "member"] as const;

/**
 * The account a console tab acts in, sent with each of its management calls.
 * Each tab keeps its own account: the shared cookie only picks the account a
 * new tab opens on. A person who is not an active member of the named account
 * is refused (`403 account_forbidden`). Credentials bound to one account
 * (management keys, OAuth tokens) ignore it.
 */
export const CONSOLE_ACCOUNT_HEADER = "x-account-id";
export const GRANTS = ["read", "manage"] as const;

const AccountSchema = z
  .object({ id: z.string(), name: z.string(), role: z.enum(ACCOUNT_ROLES) })
  .meta({ id: "AccountMembership" });

export const AdminSessionSchema = z
  .object({
    user: z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
    }),
    /** The account this caller acts in. */
    account: z.object({
      id: z.string(),
      name: z.string(),
      verificationPending: z.boolean().optional().meta({
        description:
          "True while this account's apps are refused (`email_unverified`) because no owner has verified their email address yet. Only where the deployment verifies addresses; left out otherwise.",
      }),
    }),
    role: z.enum(ACCOUNT_ROLES),
    grant: z.enum(GRANTS),
    credentialType: z.enum(["session", "apiKey", "oauth"]),
    /** Every account a console session may switch to. Only the current one for a key or a token. */
    accounts: z.array(AccountSchema),
    billing: SessionBillingSchema.optional().meta({
      description:
        "The account's plan and this period's request allowance. Only on a hosted deployment with billing; left out otherwise.",
    }),
  })
  .meta({ id: "AdminSession" });

export const AdminSessionResponseSchema = z.object({ session: AdminSessionSchema }).meta({ id: "AdminSessionResponse" });
export const AccountListResponseSchema = z.object({ accounts: z.array(AccountSchema) }).meta({ id: "AccountListResponse" });
export const AccountSelectRequestSchema = z.object({ accountId: z.string().min(1) }).strict().meta({ id: "AccountSelectRequest" });

/** What each credential is, for the console's access page. */
export const CREDENTIAL_KINDS = ["management_key", "cli", "mcp"] as const;

export const CredentialSchema = z
  .object({
    id: z.string(),
    kind: z.enum(CREDENTIAL_KINDS),
    /** The key's name, or the OAuth client's name. */
    name: z.string(),
    grant: z.enum(GRANTS),
    /** The last four characters of a management key. Null for an OAuth sign-in. */
    hint: z.string().nullable(),
    /** The OAuth client of a CLI login or MCP connection. Null for a key. */
    clientId: z.string().nullable(),
    /** Who it belongs to. */
    userId: z.string(),
    createdAt: z.string(),
    /** When it stops working on its own: an OAuth sign-in renews this each time it is used. */
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .meta({ id: "Credential" });

export const CredentialListResponseSchema = z
  .object({ credentials: z.array(CredentialSchema) })
  .meta({ id: "CredentialListResponse" });

export const CredentialResponseSchema = z.object({ credential: CredentialSchema }).meta({ id: "CredentialResponse" });

export const ManagementKeyCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    grant: z.enum(GRANTS).default("manage"),
  })
  .strict()
  .meta({ id: "ManagementKeyCreateRequest" });

export const CreatedManagementKeyResponseSchema = z
  .object({
    credential: CredentialSchema,
    /** The key itself, shown exactly once, here. */
    key: z.string(),
  })
  .meta({ id: "CreatedManagementKeyResponse" });

// ---------------------------------------------------------------------------
// The console's pages

export const ConsoleCapabilitiesSchema = z
  .object({
    /** A hosted deployment, with plans and billing. */
    billing: z.boolean(),
    /** Whether anyone could sign up here. */
    registrationOpen: z.boolean(),
    googleAuth: z.boolean(),
    /** Whether the CLI and MCP clients can sign in (the deployment set CONSOLE_ORIGIN). */
    oauth: z.boolean(),
    /** Whether apps can store their conversations here (the deployment has a CONVERSATIONS bucket). */
    conversationStorage: z.boolean().optional(),
    /** Whether people's email addresses are verified here (the deployment sends email). */
    emailVerification: z.boolean().optional(),
    /**
     * The support inbox, where the deployment offers human support: a help
     * desk is bound, the inbox is set, and plans are sold. Shown only, for
     * people who prefer their own mail app; the help desk decides where a
     * ticket goes. Left out where there is no support.
     */
    supportEmail: z.string().optional(),
    termsOfServiceUrl: z.string().optional(),
    privacyPolicyUrl: z.string().optional(),
    /** The gateway's release, which the CLI compares with its own after a failure. Absent on older gateways. */
    serverVersion: z.string().optional(),
  })
  .meta({ id: "ConsoleCapabilities" });

/** A console path to continue at once a verification link is opened: one beginning with a single `/`. */
export const ConsoleReturnPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\\\s]*$/u)
  .meta({ description: "A console path to continue at once the link is opened, such as `/v2/apps`." });

export const SendVerificationEmailRequestSchema = z
  .object({ returnTo: ConsoleReturnPathSchema.optional() })
  .strict()
  .meta({ id: "SendVerificationEmailRequest" });

export const SendVerificationEmailResponseSchema = z
  .object({
    status: z.enum(["sent", "already_verified"]).meta({
      description: "`sent` when a link went out now; `already_verified` when the address needs none.",
    }),
    email: z.string().meta({ description: "The address the link was sent to, or that is already verified." }),
  })
  .meta({ id: "SendVerificationEmailResponse" });

/**
 * The longest verification token the confirmation takes. The sender never
 * signs a longer one: it leaves out where to continue rather than send a link
 * that could not be confirmed.
 */
export const VERIFICATION_TOKEN_MAX_LENGTH = 4096;

/** The link a verification email carried, handed back by the page it opened. */
export const ConfirmEmailVerificationRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(VERIFICATION_TOKEN_MAX_LENGTH)
      .meta({ description: "The `token` in the `#` fragment of the link in the verification email: the page reads it there and posts it here, so it never reaches a request log." }),
  })
  .strict()
  .meta({ id: "ConfirmEmailVerificationRequest" });

export const ConfirmEmailVerificationResponseSchema = z
  .object({
    email: z.string().meta({ description: "The address now verified." }),
    returnTo: z.string().nullable().meta({ description: "The console path the link was asked for from, to continue there; null for none." }),
  })
  .meta({ id: "ConfirmEmailVerificationResponse" });

const OAuthClientSchema = z.object({
  id: z.string(),
  /** The client's own claim for a metadata-document client: show it as text. */
  name: z.string(),
  /** The host the client's metadata document was fetched from; null for a registered client. */
  domain: z.string().nullable(),
  source: z.enum(["cimd", "registered"]),
});

const OPERATION_STATES = ["pending", "completed", "denied", "expired", "retired"] as const;

/** The browser proof from the consent link's fragment. It never goes in a URL. */
export const ConsentProofSchema = z.object({ proof: z.string().min(1).max(512) }).strict().meta({ id: "ConsentProof" });

export const ConsentAllowRequestSchema = z
  .object({ proof: z.string().min(1).max(512), accountId: z.string().min(1), grant: z.enum(GRANTS) })
  .strict()
  .meta({ id: "ConsentAllowRequest" });

export const ConsentDetailsResponseSchema = z
  .object({
    id: z.string(),
    state: z.enum(OPERATION_STATES),
    client: OAuthClientSchema,
    /** Where the browser goes back to. */
    redirectHost: z.string(),
    requestedGrant: z.enum(GRANTS),
    expiresAt: z.string(),
    /** The person signed in to this browser, or null. */
    viewer: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
    /** The accounts the viewer may connect the client to. */
    accounts: z.array(AccountSchema),
    /** Why the viewer cannot allow it yet, or null. */
    blockedBy: z.enum(["sign_in_required", "no_account"]).nullable(),
  })
  .meta({ id: "ConsentDetailsResponse" });

export const ConsentRedirectResponseSchema = z
  .object({ redirect: z.string() })
  .meta({ id: "ConsentRedirectResponse" });

/** A device code as the person typed it: case and dashes do not matter. */
const UserCodeSchema = z.string().trim().min(1).max(32);

export const DeviceLookupRequestSchema = z.object({ userCode: UserCodeSchema }).strict().meta({ id: "DeviceLookupRequest" });
export const DeviceLookupResponseSchema = z
  .object({ id: z.string(), expiresAt: z.string() })
  .meta({ id: "DeviceLookupResponse" });

export const DeviceCodeRequestSchema = z.object({ userCode: UserCodeSchema }).strict().meta({ id: "DeviceCodeRequest" });

export const DeviceApproveRequestSchema = z
  .object({ userCode: UserCodeSchema, accountId: z.string().min(1), grant: z.enum(GRANTS) })
  .strict()
  .meta({ id: "DeviceApproveRequest" });

export const DeviceDetailsResponseSchema = z
  .object({
    id: z.string(),
    state: z.enum(OPERATION_STATES),
    client: OAuthClientSchema,
    requestedGrant: z.enum(GRANTS),
    /** Show it, and ask the person to check it matches the one on their device. */
    userCode: z.string().nullable(),
    expiresAt: z.string(),
    accounts: z.array(AccountSchema),
  })
  .meta({ id: "DeviceDetailsResponse" });

export const DeviceAnswerResponseSchema = z
  .object({ state: z.enum(["completed", "denied"]) })
  .meta({ id: "DeviceAnswerResponse" });
