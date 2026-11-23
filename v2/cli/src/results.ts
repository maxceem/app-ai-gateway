import type { SupportResult } from "./support.ts";
import type { OperationResponse } from "../../src/contracts/catalog.ts";
import type {
  AppAddResult,
  AppKeyAddResult,
  AppUpdateResult,
  AppValidateResult,
  ProviderResult,
} from "./commands.ts";
import type { LoginResult, LogoutResult } from "./context.ts";
import type { ConversationsExportResult } from "./conversations.ts";

/** What `agw deployment status` reports about the selected gateway. */
export interface DeploymentStatusResult {
  url: string;
  connected: true;
  /** How commands are signed in, if at all. */
  credential: "oauth" | "environment" | null;
  signedIn: boolean;
  user?: LoginResult["user"];
  account?: LoginResult["account"];
  role?: string;
  grant?: string;
  /** The gateway's release, when it reports one. */
  serverVersion?: string;
}

export type OperationStatus = OperationResponse<"getOperation">;

/** Everything a built-in command can return, and therefore everything stdout can carry for one. */
export type CommandResult =
  | LoginResult
  | LogoutResult
  | DeploymentStatusResult
  | ProviderResult
  | AppAddResult
  | AppValidateResult
  | AppKeyAddResult
  | AppUpdateResult
  | ConversationsExportResult
  | SupportResult
  | OperationStatus;
