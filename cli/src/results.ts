import type {
  CliAccountResponse,
  CliCapabilitiesResponse,
  CliOperationResponse,
  CliPollResponse,
} from "../../src/contracts/cli.ts";
import type { AppResult } from "./apps.ts";
import type { Onboarding } from "./context.ts";
import type { DeploymentResult } from "./deployment.ts";
import type { ResourceResult } from "./resources.ts";
import type { UsageResult } from "./usage.ts";

/** What `agw deployment status` reports about the selected connection. */
export type DeploymentStatusResult = CliCapabilitiesResponse & {
  url: string;
  authenticated: boolean;
  connected: true;
};

/** Everything a command can return, and therefore everything stdout can carry. */
export type CommandResult =
  | ResourceResult
  | AppResult
  | UsageResult
  | DeploymentResult
  | DeploymentStatusResult
  | CliAccountResponse
  | (CliAccountResponse & { connected: true })
  | CliOperationResponse
  | CliPollResponse
  | { loggedOut: true };

/**
 * A result as it is printed. A first-run command folds the account it just
 * created into its own answer, which is where the free-access dates come from.
 */
export type RenderedResult = CommandResult | (CommandResult & Onboarding);
