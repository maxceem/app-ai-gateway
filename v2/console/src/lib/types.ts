/**
 * The API's types, under the names the console calls them by.
 *
 * Read from the v2 operation catalog in `v2/src/contracts`, where those shapes
 * are defined once and where the Worker's handlers are checked against them,
 * so the console can never describe a wire shape the gateway has moved.
 * Type-only, so the console bundle gains nothing at runtime.
 */
import type { OperationResponse } from "@contracts/catalog";

/** Optional deployment features, read once before the app renders. */
export type Capabilities = OperationResponse<"getConsoleCapabilities">;

/** Who is signed in, the account they act in, and every account they may switch to. */
export type Session = OperationResponse<"getAdminSession">["session"];

/** One account the person belongs to, with their role in it. */
export type AccountMembership = Session["accounts"][number];

export type AccountRole = Session["role"];

/** `read` may look; `manage` may change things too. */
export type Grant = Session["grant"];

/** A management key, a CLI login or an MCP connection. */
export type Credential = OperationResponse<"listCredentials">["credentials"][number];
export type CredentialKind = Credential["kind"];

/** A new management key: its row, and the key itself, shown exactly once. */
export type CreatedManagementKey = OperationResponse<"createManagementKey">;

export type ConsentDetails = OperationResponse<"getOauthConsent">;
export type DeviceDetails = OperationResponse<"getDeviceRequest">;

export type App = OperationResponse<"getApp">["app"];
export type AppConfig = App["config"];
export type AppCheck = OperationResponse<"checkApp">;
export type AppKey = OperationResponse<"listAppKeys">["keys"][number];
export type CreatedApp = OperationResponse<"createApp">;
export type CreatedAppKey = OperationResponse<"createAppKey">;
export type EndUser = OperationResponse<"listAppUsers">["users"][number];
export type ProviderConnection = OperationResponse<"listProviders">["providers"][number];
export type ProviderTestResult = OperationResponse<"testProvider">;
export type PriceList = OperationResponse<"listModelPrices">["prices"];
