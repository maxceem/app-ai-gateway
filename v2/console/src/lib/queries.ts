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
  jobs: (appId: string, query: unknown) => ["jobs", appId, query] as const,
  accountUsage: (month: string) => ["account-usage", month] as const,
  appUsage: (appId: string) => ["app-usage", appId] as const,
  timeseries: (appId: string, query: unknown) => ["usage-timeseries", appId, query] as const,
  breakdown: (appId: string, query: unknown) => ["usage-breakdown", appId, query] as const,
  charges: (appId: string, query: unknown) => ["charges", appId, query] as const,
  authSummary: (appId: string, days: number) => ["auth-summary", appId, days] as const,
  authEvents: (appId: string, query: unknown) => ["auth-events", appId, query] as const,
  rejections: (appId: string, query: unknown) => ["rejection-events", appId, query] as const,
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

export type JobQuery = OperationQuery<"listAppJobs">;

/** How often an open Jobs tab asks again, so a settled or late check shows without a reload. */
export const JOBS_REFRESH_MS = 30_000;

export function useAppJobs(appId: string, query: JobQuery) {
  return useQuery({
    queryKey: keys.jobs(appId, query),
    queryFn: () => call("listAppJobs", { params: { app: appId }, query }),
    refetchInterval: JOBS_REFRESH_MS,
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
 * Reads one connection fresh from the server, not from the cached list, and
 * stores the new list. For a dialog that must restart from the server's own
 * latest version, such as after a conflict. Throws when the read fails.
 */
export function useFreshProvider() {
  const client = useQueryClient();
  return async (id: string) => {
    const list = await client.fetchQuery({ queryKey: keys.providers, queryFn: () => call("listProviders"), staleTime: 0 });
    return list.providers.find((provider) => provider.id === id) ?? null;
  };
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
    // A refused delete refreshes too: the connection may already be gone.
    onSettled: () => invalidateProviders(client),
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

// ---------------------------------------------------------------------------
// Usage and diagnostics: read-only, so nothing here invalidates anything

/** The whole account's usage in one UTC month, with a line per app, deleted apps included. */
export function useAccountUsage(month: string, refetchInterval?: number) {
  return useQuery({
    queryKey: keys.accountUsage(month),
    queryFn: () => call("getAccountUsage", { query: { month } }),
    refetchInterval,
  });
}

/**
 * Whether an app has ever made a call, v1's first-request check, read once
 * when the page loads, and again only when the person asks (`refresh`): no
 * live check (owner, 2026-11-22). Read from the app's usage
 * totals (`first_usage_day`), which outlive its charges: an app whose last
 * charge aged out still has made calls. A gateway from before that field
 * answers without it, and then the newest charge stands in.
 */
export function useFirstCall(appId: string) {
  const usage = useQuery({
    queryKey: keys.appUsage(appId),
    queryFn: () => call("getAppUsage", { params: { app: appId }, query: {} }),
    // One read per load or click: a failed read shows its error, never retried behind the person's back.
    retry: false,
  });
  const legacy = usage.isSuccess && usage.data.first_usage_day === undefined;
  const charges = useQuery({
    queryKey: keys.charges(appId, { limit: 1 }),
    queryFn: () => call("listAppCharges", { params: { app: appId }, query: { limit: 1 } }),
    enabled: legacy,
    retry: false,
  });
  const source = legacy ? charges : usage;
  return {
    isPending: usage.isPending || (legacy && charges.isPending),
    isError: source.isError,
    /** A read is running: the first one, or one the person asked for. */
    isFetching: source.isFetching,
    /** Reads it once more, from the same place the card's answer came from. */
    // A second click while a read runs joins it rather than starting another.
    refresh: () => void source.refetch({ cancelRefetch: false }),
    /** The day of the app's first call kept; from an older gateway, of its newest charge. */
    firstDay: legacy ? (charges.data?.charges[0]?.usage_day ?? null) : (usage.data?.first_usage_day ?? null),
    /** Whether `firstDay` is the first call's, rather than the newest charge's. */
    isFirst: !legacy,
  };
}

export function useUsageTimeseries(appId: string, query: OperationQuery<"getAppUsageTimeseries">) {
  return useQuery({
    queryKey: keys.timeseries(appId, query),
    queryFn: () => call("getAppUsageTimeseries", { params: { app: appId }, query }),
  });
}

export function useUsageBreakdown(appId: string, query: OperationQuery<"getAppUsageBreakdown">) {
  return useQuery({
    queryKey: keys.breakdown(appId, query),
    queryFn: () => call("getAppUsageBreakdown", { params: { app: appId }, query }),
  });
}

export type ChargeQuery = OperationQuery<"listAppCharges">;

export function useAppCharges(appId: string, query: ChargeQuery, refetchInterval?: number) {
  return useQuery({
    queryKey: keys.charges(appId, query),
    queryFn: () => call("listAppCharges", { params: { app: appId }, query }),
    refetchInterval,
  });
}

export function useAuthEventSummary(appId: string, days: number) {
  return useQuery({
    queryKey: keys.authSummary(appId, days),
    queryFn: () => call("getAppAuthEventSummary", { params: { app: appId }, query: { days } }),
  });
}

export type AuthEventQuery = OperationQuery<"listAppAuthEvents">;

export function useAuthEvents(appId: string, query: AuthEventQuery) {
  return useQuery({
    queryKey: keys.authEvents(appId, query),
    queryFn: () => call("listAppAuthEvents", { params: { app: appId }, query }),
  });
}

export type RejectionQuery = OperationQuery<"listAppRejectionEvents">;

export function useRejectionEvents(appId: string, query: RejectionQuery) {
  return useQuery({
    queryKey: keys.rejections(appId, query),
    queryFn: () => call("listAppRejectionEvents", { params: { app: appId }, query }),
  });
}
