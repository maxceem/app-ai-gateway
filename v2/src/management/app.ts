/**
 * Everything that is not an app's own call or MCP: the management API
 * (`/v2/admin/*`), the CLI's tool catalog (`/v2/cli/*`), sign-in
 * (`/v2/auth/*`), the OAuth server (`/v2/oauth/*` and its discovery
 * documents) and the console's pages (`/v2/console/*`).
 *
 * The entry module (`../index.ts`) loads this on first use, so none of it,
 * nor the sign-in library, nor the management schemas, is evaluated on a
 * provider request's cold start (v1's lazy loading, kept). A test checks that
 * the entry module cannot reach it statically.
 *
 * Errors are this app's to map and the entry module's to format: a cf-auth
 * refusal becomes the gateway's own error here, and is thrown on for the entry
 * module's `onError`.
 */
import type { AuthState, CfAuth } from "@maxceem/cf-auth";
import { Hono } from "hono";
import { gatewayErrorOf } from "../auth/identity.ts";
import { adminAuth, type AdminVariables } from "../admin/actor.ts";
import {
  createManagementKey,
  getAdminSession,
  listAccounts,
  listCredentials,
  revokeCredential,
  selectAccount,
} from "../admin/access.ts";
import {
  checkApp,
  createApp,
  createAppKey,
  deleteApp,
  getApp,
  listAppKeys,
  listApps,
  patchApp,
  revokeAppKey,
  updateApp,
  validateApp,
  validateAppDraft,
} from "../admin/apps.ts";
import { callCliTool, listCliTools } from "../admin/cli-tools.ts";
import { listModelPrices } from "../admin/prices.ts";
import { createProvider, deleteProvider, getProvider, listProviders, testProvider, updateProvider } from "../admin/providers.ts";
import { blockAppUser, getAppUser, listAppUsers, unblockAppUser } from "../admin/users.ts";
import { CATALOG, type OperationName } from "../contracts/catalog.ts";
import { honoPath } from "../contracts/client-catalog.ts";
import { consoleRoutes } from "./console-routes.ts";
import { identityRoutes } from "./identity-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";

type ManagementEnv = { Bindings: Env; Variables: { identity: Promise<CfAuth>; authState: AuthState } };

const app = new Hono<ManagementEnv>();

const path = (name: OperationName): string => honoPath(CATALOG[name].path);

const admin = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
admin.use("/v2/admin/*", adminAuth);
admin.get(path("getAdminSession"), getAdminSession);
admin.get(path("listAccounts"), listAccounts);
admin.post(path("selectAccount"), selectAccount);
admin.get(path("listCredentials"), listCredentials);
admin.post(path("createManagementKey"), createManagementKey);
admin.post(path("revokeCredential"), revokeCredential);
admin.get(path("listApps"), listApps);
admin.post(path("createApp"), createApp);
admin.get(path("getApp"), getApp);
admin.put(path("updateApp"), updateApp);
admin.patch(path("patchApp"), patchApp);
admin.delete(path("deleteApp"), deleteApp);
admin.post(path("validateApp"), validateApp);
admin.post(path("validateAppDraft"), validateAppDraft);
admin.get(path("checkApp"), checkApp);
admin.get(path("listAppKeys"), listAppKeys);
admin.post(path("createAppKey"), createAppKey);
admin.post(path("revokeAppKey"), revokeAppKey);
admin.get(path("listAppUsers"), listAppUsers);
admin.get(path("getAppUser"), getAppUser);
admin.post(path("blockAppUser"), blockAppUser);
admin.post(path("unblockAppUser"), unblockAppUser);
admin.get(path("listModelPrices"), listModelPrices);
admin.get(path("listProviders"), listProviders);
admin.post(path("testProvider"), testProvider);
admin.post(path("createProvider"), createProvider);
admin.get(path("getProvider"), getProvider);
admin.put(path("updateProvider"), updateProvider);
admin.delete(path("deleteProvider"), deleteProvider);
// The CLI's tool catalog: the list is public, a call is the caller's.
admin.get(path("listCliTools"), listCliTools);
admin.post(path("callCliTool"), adminAuth, callCliTool);

app.route("/", admin);
app.route("/", identityRoutes);
app.route("/", oauthRoutes);
app.route("/", consoleRoutes);

app.notFound((c) => c.json({ error: { code: "not_found", message: "Nothing is served at this path." } }, 404));
app.onError((error) => {
  throw gatewayErrorOf(error);
});

export default app;
