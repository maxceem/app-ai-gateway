import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperationQuery, OperationRequest } from "@contracts/catalog";
import { ApiError, call } from "./api";
import { beginAccountSwitch, cancelAccountSwitch, currentSearch, setTabAccount, switchTabAccount, tabAccount } from "./tab-account";
import { checkoutReturnAccount } from "./auth-redirect";
import type { Session } from "./types";
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
  /** Every account's billing status, for an invalidation that is about all of them. */
  billingStatusPrefix: ["billing-status"] as const,
  billingStatus: (accountId: string) => ["billing-status", accountId] as const,
  billingPlans: ["billing-plans"] as const,
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
 * The operator's identity, current account and role, for the account this
 * tab names (a new tab: the one the shared cookie selects).
 *
 * Better Auth is asked first, and a browser it says is signed out is answered
 * `null` without a management call, which could only have been refused. A
 * 401 from the management API is still the unauthenticated case rather than
 * an error worth retrying, so the caller treats a failed query as "signed out".
 */
/** A page that is about to reload: nothing renders from it meanwhile. */
const reloading = new Promise<never>(() => undefined);

export const readSession = async (signal?: AbortSignal): Promise<Session | null> => {
  // A session that has expired keeps the tab's saved account: after signing
  // in again, the tab comes back to it. Only signing out forgets it.
  if (await plainlySignedOut()) return null;
  const named = tabAccount();
  let session: Session;
  try {
    session = (await call("getAdminSession", signal === undefined ? {} : { signal })).session;
  } catch (error) {
    // The tab's saved account is not (or no longer) the person's: the
    // request code has already made the tab fall back to the account the
    // session selects, reloading once.
    if (error instanceof ApiError && error.code === "account_forbidden" && named !== null) return reloading;
    throw error;
  }
  if (named !== null) return session;
  // A tab with no saved account. A checkout return (or the sign-in page
  // carrying one) names the account it was for: a candidate only, taken when
  // the person is an active member of it, as an account switch.
  const returned = checkoutReturnAccount(currentSearch());
  if (returned !== null && returned !== session.account.id && session.accounts.some((entry) => entry.id === returned)) {
    await call("selectAccount", { body: { accountId: returned }, ...(signal === undefined ? {} : { signal }) });
    switchTabAccount(returned);
    return reloading;
  }
  setTabAccount(session.account.id);
  return session;
};

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: ({ signal }) => readSession(signal),
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
    mutationFn: ({ returnPath, ...input }: SignUpInput & { returnPath?: string }) => signUpWithPassword(input, returnPath),
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => signOut(),
    // Only once signing out succeeded: the tab forgets its account, and
    // clearing rather than invalidating drops every account-scoped cache, so
    // the next operator never sees the previous one's data. A failed sign-out
    // leaves the person signed in, on the same account.
    onSuccess: () => {
      setTabAccount(null);
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

/**
 * Sends the signed-in person a new verification link. Their session is read
 * again afterwards, in case the address was verified meanwhile.
 */
export function useSendVerificationEmail() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (returnTo?: string) => call("sendVerificationEmail", { body: returnTo === undefined ? {} : { returnTo } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.session }),
  });
}

/** Confirms the link a verification email carried. Needs no sign-in: the link is the proof. */
export function useConfirmEmailVerification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => call("confirmEmailVerification", { body: { token } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.session }),
  });
}

/** How long a switch request may take before the page carries on without it. */
export const SWITCH_DEADLINE_MS = 10_000;

/**
 * Switches the account this tab acts in. The gateway makes it the account new
 * tabs open on, and the page then reloads on it: nothing is swapped in place.
 * The switch stays pending until the page goes, so nothing can be done meanwhile.
 */
export function useSelectAccount() {
  return useMutation({
    mutationFn: async (accountId: string) => {
      // The switch request is sent first; from the moment it is out, the page
      // sends nothing else (`./api` refuses) and takes no input. It has a
      // deadline, so a gateway that never answers cannot lock the page.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), SWITCH_DEADLINE_MS);
      const switched = call("selectAccount", { body: { accountId }, signal: deadline.signal });
      beginAccountSwitch();
      try {
        return await switched;
      } catch (error) {
        if (deadline.signal.aborted) throw new Error("Switching account took too long. Try again.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    onError: () => cancelAccountSwitch(),
    onSuccess: (result) => {
      switchTabAccount(result.session.account.id);
      return reloading;
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
export function useAccountUsage(month: string) {
  return useQuery({
    queryKey: keys.accountUsage(month),
    queryFn: () => call("getAccountUsage", { query: { month } }),
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

export function useAppCharges(appId: string, query: ChargeQuery) {
  return useQuery({
    queryKey: keys.charges(appId, query),
    queryFn: () => call("listAppCharges", { params: { app: appId }, query }),
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

// ---------------------------------------------------------------------------
// Billing: a hosted deployment only (the `billing` capability). Nothing here
// moves money: a checkout is finished on the billing provider's own page.

/**
 * The account's plan and allowance. Polled gently, since the allowance moves
 * with every request. Kept under the account it was read for, so a switch
 * never shows one account's plan under another's name.
 */
export function useBillingStatus(enabled: boolean, accountId: string) {
  return useQuery({
    queryKey: keys.billingStatus(accountId),
    queryFn: ({ signal }) => call("getBillingStatus", { signal }),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
  });
}

export function useBillingPlans(enabled: boolean) {
  return useQuery({
    queryKey: keys.billingPlans,
    queryFn: () => call("listBillingPlans"),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Whatever changes the plan changes the status and the session's plan line. */
function useRefreshPlan() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.billingStatusPrefix });
    void client.invalidateQueries({ queryKey: keys.session });
  };
}

/**
 * Starts a checkout. The gateway picks where the provider sends the person
 * back (the apps page, which announces it, or the plans), and answers the same
 * page again while a checkout for the same plan is open.
 */
/**
 * Marks a billing action that can send the page to a payment page (checkout,
 * change, resume): while one is pending, the account cannot be switched.
 */
export const PAYMENT_ACTION_KEY = ["payment-action"] as const;

export function useStartCheckout() {
  return useMutation({
    mutationKey: [...PAYMENT_ACTION_KEY, "checkout"],
    mutationFn: (input: OperationRequest<"startCheckout">) => call("startCheckout", { body: input }),
  });
}

export function useChangePlan() {
  const refresh = useRefreshPlan();
  return useMutation({
    mutationKey: [...PAYMENT_ACTION_KEY, "change"],
    mutationFn: (input: OperationRequest<"changePlan">) => call("changePlan", { body: input }),
    onSuccess: refresh,
  });
}

export function useResumeSubscription() {
  const refresh = useRefreshPlan();
  return useMutation({
    mutationKey: [...PAYMENT_ACTION_KEY, "resume"],
    mutationFn: (input: OperationRequest<"resumeSubscription">) => call("resumeSubscription", { body: input }),
    onSuccess: refresh,
  });
}

export function useCancelSubscription() {
  const refresh = useRefreshPlan();
  return useMutation({
    mutationFn: (input: OperationRequest<"cancelSubscription">) => call("cancelSubscription", { body: input }),
    onSuccess: refresh,
  });
}
