import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperationQuery, OperationRequest } from "@contracts/catalog";
import { call } from "./api";
import {
  changePassword,
  plainlySignedOut,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  type SignInInput,
  type SignUpInput,
} from "./auth";

export const keys = {
  capabilities: ["capabilities"] as const,
  session: ["session"] as const,
  accounts: ["accounts"] as const,
  credentials: ["credentials"] as const,
  apps: ["apps"] as const,
  app: (appId: string) => ["app", appId] as const,
  appCheck: (appId: string) => ["app-check", appId] as const,
  appKeys: (appId: string) => ["app-keys", appId] as const,
  /** Every page of one app's users, for an invalidation that is about all of them. */
  usersPrefix: (appId: string) => ["users", appId] as const,
  users: (appId: string, query: unknown) => ["users", appId, query] as const,
  providers: ["providers"] as const,
  prices: ["prices"] as const,
};

/**
 * Deployment capabilities gate whole features (signup, Google, CLI sign-in),
 * so they are fetched before anything else and never refetched.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: keys.capabilities,
    queryFn: () => call("getConsoleCapabilities"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * The operator's identity, current account and role.
 *
 * Better Auth is asked first, and a browser it says is signed out is answered
 * `null` without a management call, which could only have been refused. A
 * 401 from the management API is still the unauthenticated case rather than
 * an error worth retrying, so the caller treats a failed query as "signed out".
 */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => (await plainlySignedOut()) ? null : (await call("getAdminSession")).session,
    retry: false,
    staleTime: 60_000,
  });
}

export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SignInInput) => signInWithPassword(input),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SignUpInput) => signUpWithPassword(input),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => signOut(),
    // Clearing rather than invalidating drops every account-scoped cache, so
    // the next operator never sees the previous one's data.
    onSettled: () => {
      client.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword({ ...input, revokeOtherSessions: true }),
  });
}

export function useSelectAccount() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => call("selectAccount", { body: { accountId } }),
    onSuccess: async (result) => {
      client.setQueryData(keys.session, result.session);
      // Every cached list belongs to the previous account, so its data is
      // dropped. Reset rather than `clear()`: clearing removes the queries the
      // mounted pages observe, which then keep showing the previous account's
      // data and never fetch again. A reset empties them in place and
      // refetches the ones on screen. The session was just replaced, and the
      // capabilities describe the deployment, so both are kept.
      const kept: readonly unknown[] = [keys.session[0], keys.capabilities[0]];
      await client.resetQueries({ predicate: (query) => !kept.includes(query.queryKey[0]) });
    },
  });
}

/** Management keys, CLI logins and MCP connections, in one list. */
export function useCredentials() {
  return useQuery({
    queryKey: keys.credentials,
    queryFn: () => call("listCredentials"),
  });
}

export function useCreateManagementKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OperationRequest<"createManagementKey">) => call("createManagementKey", { body }),
    // The result holds the only copy of a live credential. Without this the
    // cached mutation outlives `reset()` and keeps the plaintext in memory.
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

export function useRevokeCredential() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call("revokeCredential", { params: { id } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.credentials }),
  });
}

// ---------------------------------------------------------------------------
// Apps

export function useApps() {
  return useQuery({ queryKey: keys.apps, queryFn: () => call("listApps") });
}

export function useApp(appId: string) {
  return useQuery({ queryKey: keys.app(appId), queryFn: () => call("getApp", { params: { app: appId } }) });
}

/** Whether the connections an app names are in place. */
export function useAppCheck(appId: string) {
  return useQuery({ queryKey: keys.appCheck(appId), queryFn: () => call("checkApp", { params: { app: appId } }) });
}

/** Refreshes everything one app's change can move. */
function invalidateApp(client: ReturnType<typeof useQueryClient>, appId: string) {
  void client.invalidateQueries({ queryKey: keys.apps });
  void client.invalidateQueries({ queryKey: keys.app(appId) });
  void client.invalidateQueries({ queryKey: keys.appCheck(appId) });
}

export function useCreateApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OperationRequest<"createApp">) => call("createApp", { body }),
    // An app-key app's first key is in the answer, shown once.
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apps }),
  });
}

/** Saves the whole app, at the revision it was read at: a stale one is refused with 409. */
export function useUpdateApp(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OperationRequest<"updateApp">) => call("updateApp", { params: { app: appId }, body }),
    onSuccess: (result) => {
      client.setQueryData(keys.app(appId), result);
      invalidateApp(client, appId);
    },
    // A refused save, such as a stale revision, reloads the app, so the next
    // try starts from the latest version.
    onError: () => invalidateApp(client, appId),
  });
}

/** Checks a whole app as a save would, without saving it. */
export function useValidateApp(appId: string) {
  return useMutation({
    mutationFn: (body: OperationRequest<"validateApp">) => call("validateApp", { params: { app: appId }, body }),
  });
}

export function useDeleteApp() {
  const client = useQueryClient();
  return useMutation({
    // The API asks for the app id again, so a delete is never by accident.
    mutationFn: (appId: string) => call("deleteApp", { params: { app: appId }, query: { confirm: appId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apps }),
  });
}

export function useAppKeys(appId: string, enabled = true) {
  return useQuery({
    queryKey: keys.appKeys(appId),
    queryFn: () => call("listAppKeys", { params: { app: appId } }),
    enabled,
  });
}

export function useCreateAppKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => call("createAppKey", { params: { app: appId }, body: { name } }),
    // The result holds the only copy of the key.
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.appKeys(appId) }),
  });
}

export function useRevokeAppKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => call("revokeAppKey", { params: { app: appId, key: keyId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.appKeys(appId) }),
  });
}

export type UserQuery = OperationQuery<"listAppUsers">;

export function useAppUsers(appId: string, query: UserQuery) {
  return useQuery({
    queryKey: keys.users(appId, query),
    queryFn: () => call("listAppUsers", { params: { app: appId }, query }),
  });
}

export function useUserAction(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, block }: { userId: string; block: boolean }) =>
      call(block ? "blockAppUser" : "unblockAppUser", { params: { app: appId, user: userId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.usersPrefix(appId) }),
  });
}

// ---------------------------------------------------------------------------
// Provider connections and prices

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => call("listProviders") });
}

/**
 * A connection's change can make an app ready or not, so every app's check
 * is refreshed with the list. A refused update is refreshed too, so a retry
 * after someone else's change uses the new revision.
 */
function invalidateProviders(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: keys.providers });
  void client.invalidateQueries({ queryKey: ["app-check"] });
}

/**
 * The key a person typed rides in a mutation's variables. These mutations
 * keep nothing once they settle (`gcTime: 0`), and their dialogs reset them
 * when they close, so the key is not left in memory.
 */
export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OperationRequest<"createProvider">) => call("createProvider", { body }),
    gcTime: 0,
    onSettled: () => invalidateProviders(client),
  });
}

export function useUpdateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: OperationRequest<"updateProvider"> }) =>
      call("updateProvider", { params: { id }, body }),
    gcTime: 0,
    onSettled: () => invalidateProviders(client),
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call("deleteProvider", { params: { id } }),
    onSuccess: () => invalidateProviders(client),
  });
}

/** Tests a key against its provider. Stores nothing, and keeps nothing once it settles. */
export function useTestProvider() {
  return useMutation({
    mutationFn: (body: OperationRequest<"testProvider">) => call("testProvider", { body }),
    gcTime: 0,
  });
}

export function usePrices() {
  return useQuery({
    queryKey: keys.prices,
    queryFn: () => call("listModelPrices"),
    staleTime: 5 * 60_000,
  });
}
