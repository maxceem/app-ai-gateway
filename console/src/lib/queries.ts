import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, query } from "./api";
import {
  changePassword,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  type SignInInput,
  type SignUpInput,
} from "./auth";
import type {
  AppListResponse,
  AppCreateBody,
  AppResponse,
  AppUpsertBody,
  ApiKeyListResponse,
  BillingPlansResponse,
  BillingStatusResponse,
  Capabilities,
  CreatedApiKey,
  CreatedApp,
  CreatedManagementKey,
  BreakdownResponse,
  EventsResponse,
  ManagementKeyListResponse,
  MonthlyUsage,
  OrganizationListResponse,
  PricesResponse,
  ProviderCreateBody,
  ProviderTestBody,
  ProviderTestResult,
  ProviderGatewayCreateBody,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewayTestBody,
  ProviderListResponse,
  ProviderResponse,
  ProviderUpdateBody,
  SessionResponse,
  TimeseriesResponse,
  UserListResponse,
} from "./types";

export const keys = {
  capabilities: ["capabilities"] as const,
  session: ["session"] as const,
  organizations: ["organizations"] as const,
  managementKeys: ["management-keys"] as const,
  providers: ["providers"] as const,
  providerGateways: ["provider-gateways"] as const,
  billingStatus: ["billing", "status"] as const,
  billingPlans: ["billing", "plans"] as const,
  apps: (month: string) => ["apps", month] as const,
  app: (appId: string) => ["app", appId] as const,
  apiKeys: (appId: string) => ["api-keys", appId] as const,
  users: (appId: string, params: unknown) => ["users", appId, params] as const,
  usage: (appId: string, month: string) => ["usage", appId, month] as const,
  timeseries: (appId: string, from: string, to: string) => ["timeseries", appId, from, to] as const,
  breakdown: (appId: string, by: string, from: string, to: string) =>
    ["breakdown", appId, by, from, to] as const,
  events: (appId: string, params: unknown) => ["events", appId, params] as const,
  prices: ["prices"] as const,
};

/**
 * Deployment capabilities gate whole features (billing, signup, Google), so
 * they are fetched before anything else and never refetched.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: keys.capabilities,
    queryFn: () => api.get<Capabilities>("/v1/console/capabilities"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * The operator's identity, active organization and role.
 *
 * A 401 here is the normal unauthenticated case rather than an error worth
 * retrying, so the caller treats a failed query as "signed out".
 */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => (await api.get<SessionResponse>("/v1/admin/session")).session,
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
    // Clearing rather than invalidating drops every organization-scoped cache
    // so the next operator never sees the previous one's data.
    onSettled: () => client.clear(),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword({ ...input, revokeOtherSessions: true }),
  });
}

export function useOrganizations(enabled = true) {
  return useQuery({
    queryKey: keys.organizations,
    queryFn: () => api.get<OrganizationListResponse>("/v1/admin/organizations"),
    enabled,
  });
}

export function useSelectOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      api.post<SessionResponse>("/v1/admin/organizations/select", { organizationId }),
    onSuccess: (result) => {
      // Every cached list is scoped to the previous organization.
      client.clear();
      client.setQueryData(keys.session, result.session);
    },
  });
}

export function useManagementKeys() {
  return useQuery({
    queryKey: keys.managementKeys,
    queryFn: () => api.get<ManagementKeyListResponse>("/v1/admin/keys"),
  });
}

export function useCreateManagementKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ key: CreatedManagementKey }>("/v1/admin/keys", { name }),
    // The result holds the only copy of a live credential. Without this the
    // cached mutation outlives `reset()` and keeps the plaintext in memory.
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.managementKeys }),
  });
}

export function useRevokeManagementKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api.post(`/v1/admin/keys/${encodeURIComponent(keyId)}/revoke`),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.managementKeys }),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => api.get<ProviderListResponse>("/v1/admin/providers"),
  });
}

/**
 * The same list as an array, disabled rows included. A disabled instance still
 * exists and the server still accepts configuration naming it, so the editor
 * shows it with its own badge rather than dropping it and silently rewriting
 * what the app is configured to do.
 *
 * No deduplication needed: a slug is held by exactly one row until that row is
 * deleted, disabled rows included, so every slug appears at most once.
 */
export function useProviderInstances() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => api.get<ProviderListResponse>("/v1/admin/providers"),
    select: (data) => data.providers,
  });
}

/**
 * Adding or removing a provider row also moves its gateway's `providerCount`,
 * which is what enables or blocks that gateway's delete action on the same
 * screen — so both lists are refreshed together.
 */
function invalidateProviderLists(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: keys.providers });
  void client.invalidateQueries({ queryKey: keys.providerGateways });
}

/**
 * Provider credentials are submitted once and never returned. `gcTime: 0` keeps
 * the plaintext out of the mutation cache the moment the call settles, the same
 * way management-key creation does.
 */
export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderCreateBody) =>
      api.post<ProviderResponse>("/v1/admin/providers", body),
    gcTime: 0,
    onSuccess: () => invalidateProviderLists(client),
  });
}

/**
 * Checks a credential against the provider without storing it, so testing is
 * something the operator may do rather than a gate on adding the provider.
 * `gcTime: 0` keeps the submitted secret out of the mutation cache.
 */
export function useTestProvider() {
  return useMutation({
    mutationFn: (body: ProviderTestBody) =>
      api.post<ProviderTestResult>("/v1/admin/providers/test", body),
    gcTime: 0,
  });
}

export function useTestProviderGateway() {
  return useMutation({
    mutationFn: (body: ProviderGatewayTestBody) =>
      api.post<ProviderTestResult>("/v1/admin/provider-gateways/test", body),
    gcTime: 0,
  });
}

export function useProviderGateways() {
  return useQuery({
    queryKey: keys.providerGateways,
    queryFn: () => api.get<ProviderGatewayListResponse>("/v1/admin/provider-gateways"),
  });
}

/**
 * Gateway mutations refresh the provider list too: a provider row is labelled
 * with its gateway's name. `gcTime: 0` keeps the tokens create and rotate carry
 * out of the mutation cache, as provider creation does.
 */
function useGatewayMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    gcTime: 0,
    onSuccess: () => invalidateProviderLists(client),
  });
}

export function useCreateProviderGateway() {
  return useGatewayMutation((body: ProviderGatewayCreateBody) =>
    api.post<ProviderGatewayResponse>("/v1/admin/provider-gateways", body),
  );
}

export function useRenameProviderGateway() {
  return useGatewayMutation(({ id, name }: { id: string; name: string }) =>
    api.patch<ProviderGatewayResponse>(
      `/v1/admin/provider-gateways/${encodeURIComponent(id)}`,
      { name },
    ),
  );
}

/** A single re-encryption, shared by every provider behind the gateway. */
export function useRotateProviderGateway() {
  return useGatewayMutation(({ id, token }: { id: string; token: string }) =>
    api.post<ProviderGatewayResponse>(
      `/v1/admin/provider-gateways/${encodeURIComponent(id)}/rotate`,
      { token },
    ),
  );
}

export function useDeleteProviderGateway() {
  return useGatewayMutation((id: string) =>
    api.delete<{ deleted: true; provider_gateway_id: string }>(
      `/v1/admin/provider-gateways/${encodeURIComponent(id)}`,
    ),
  );
}

/**
 * Rotation, rename, pricing edits and the disable/enable toggle share one
 * endpoint. None of them move a row between gateways, so no gateway count
 * changes here — but a status change does move which instances an all-mode app
 * reaches, which the apps list reports, so that is refreshed with it.
 */
export function useUpdateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderUpdateBody }) =>
      api.put<ProviderResponse>(`/v1/admin/providers/${encodeURIComponent(id)}`, body),
    gcTime: 0,
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({ queryKey: keys.providers });
      if (variables.body.status !== undefined) {
        void client.invalidateQueries({ queryKey: ["apps"] });
      }
    },
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ deleted: true; provider_id: string }>(
        `/v1/admin/providers/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => invalidateProviderLists(client),
  });
}

/**
 * Billing hooks stay disabled unless the deployment reports the capability.
 *
 * A subscription can lapse while the console is open — a card expires, a trial
 * ends — and the data plane starts answering 402. Polling and refetching on
 * focus keep the banner honest without waiting for a reload; the query client
 * additionally refreshes this on any 402.
 */
export function useBillingStatus(enabled: boolean) {
  return useQuery({
    queryKey: keys.billingStatus,
    queryFn: () => api.get<BillingStatusResponse>("/v1/admin/billing/status"),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useBillingPlans(enabled: boolean) {
  return useQuery({
    queryKey: keys.billingPlans,
    queryFn: () => api.get<BillingPlansResponse>("/v1/admin/billing/plans"),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useStartCheckout() {
  return useMutation({
    mutationFn: (input: { planKey: string; billingPeriod: "month" | "year" }) =>
      api.post<{ url: string }>("/v1/admin/billing/checkout", {
        ...input,
        successUrl: `${window.location.origin}/billing`,
        cancelUrl: `${window.location.origin}/billing`,
      }),
  });
}

export function useCancelSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/v1/admin/billing/cancel"),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.billingStatus }),
  });
}

export function useResumeSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { planKey: string; billingPeriod: "month" | "year" }) =>
      api.post<{ ok: true; requiredActionUrl?: string }>("/v1/admin/billing/resume", input),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.billingStatus }),
  });
}

export function useApps(month: string) {
  return useQuery({
    queryKey: keys.apps(month),
    queryFn: () => api.get<AppListResponse>(`/v1/admin/apps${query({ month })}`),
  });
}

export function useApp(appId: string) {
  return useQuery({
    queryKey: keys.app(appId),
    queryFn: () => api.get<AppResponse>(`/v1/admin/apps/${encodeURIComponent(appId)}`),
  });
}

export function useSaveApp(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AppUpsertBody) =>
      api.put<{ app: unknown }>(`/v1/admin/apps/${encodeURIComponent(appId)}`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.app(appId) });
      void client.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

export function useCreateApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AppCreateBody) => api.post<CreatedApp>("/v1/admin/apps", body),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: keys.app(created.app_id) });
      void client.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

export function useValidateApp(appId: string) {
  return useMutation({
    mutationFn: (body: AppUpsertBody) =>
      api.post<{ valid: boolean; exists: boolean }>(
        `/v1/admin/apps/${encodeURIComponent(appId)}/validate`,
        body,
      ),
  });
}

export function useDeleteApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) =>
      api.delete<{ deleted: string; removed_users: number }>(
        `/v1/admin/apps/${encodeURIComponent(appId)}${query({ confirm: appId })}`,
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["apps"] }),
  });
}

export function useApiKeys(appId: string) {
  return useQuery({
    queryKey: keys.apiKeys(appId),
    queryFn: () =>
      api.get<ApiKeyListResponse>(`/v1/admin/apps/${encodeURIComponent(appId)}/keys`),
  });
}

export function useCreateApiKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post<CreatedApiKey>(`/v1/admin/apps/${encodeURIComponent(appId)}/keys`, { name }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apiKeys(appId) }),
  });
}

export function useRevokeApiKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api.post(`/v1/admin/apps/${encodeURIComponent(appId)}/keys/${encodeURIComponent(keyId)}/revoke`),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apiKeys(appId) }),
  });
}

export interface UserQuery {
  month: string;
  query?: string;
  status?: "active" | "blocked";
  limit?: number;
  offset?: number;
}

export function useUsers(appId: string, params: UserQuery) {
  return useQuery({
    queryKey: keys.users(appId, params),
    queryFn: () =>
      api.get<UserListResponse>(`/v1/admin/apps/${encodeURIComponent(appId)}/users${query({ ...params })}`),
    placeholderData: (previous) => previous,
  });
}

export function useUserAction(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, blocked }: { userId: string; blocked: boolean }) =>
      api.post<{ blocked: boolean }>(
        `/v1/admin/apps/${encodeURIComponent(appId)}/users/${encodeURIComponent(userId)}/${
          blocked ? "block" : "unblock"
        }`,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["users", appId] });
      void client.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

export function useMonthlyUsage(appId: string, month: string) {
  return useQuery({
    queryKey: keys.usage(appId, month),
    queryFn: () =>
      api.get<MonthlyUsage>(`/v1/admin/apps/${encodeURIComponent(appId)}/usage${query({ month })}`),
  });
}

export function useTimeseries(appId: string, from: string, to: string) {
  return useQuery({
    queryKey: keys.timeseries(appId, from, to),
    queryFn: () =>
      api.get<TimeseriesResponse>(
        `/v1/admin/apps/${encodeURIComponent(appId)}/usage/timeseries${query({ from, to })}`,
      ),
  });
}

export function useBreakdown(appId: string, by: string, from: string, to: string) {
  return useQuery({
    queryKey: keys.breakdown(appId, by, from, to),
    queryFn: () =>
      api.get<BreakdownResponse>(
        `/v1/admin/apps/${encodeURIComponent(appId)}/usage/breakdown${query({ by, from, to })}`,
      ),
  });
}

export interface EventQuery {
  limit?: number;
  status?: string;
  provider?: string;
  user?: string;
  model?: string;
  before_id?: number;
}

export function useEvents(appId: string, params: EventQuery) {
  return useQuery({
    queryKey: keys.events(appId, params),
    queryFn: () =>
      api.get<EventsResponse>(`/v1/admin/apps/${encodeURIComponent(appId)}/events${query({ ...params })}`),
    placeholderData: (previous) => previous,
  });
}

export function usePrices() {
  return useQuery({
    queryKey: keys.prices,
    queryFn: () => api.get<PricesResponse>("/v1/admin/prices"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
