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
  MemberListResponse,
  MonthlyUsage,
  OrganizationListResponse,
  OrganizationRole,
  CfAigPresetBody,
  CfAigPresetResponse,
  PricesResponse,
  ProviderCreateBody,
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
  members: ["members"] as const,
  managementKeys: ["management-keys"] as const,
  providers: ["providers"] as const,
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

export function useMembers(enabled = true) {
  return useQuery({
    queryKey: keys.members,
    queryFn: () => api.get<MemberListResponse>("/v1/admin/members"),
    enabled,
  });
}

export function useUpdateMemberRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrganizationRole }) =>
      api.put(`/v1/admin/members/${encodeURIComponent(userId)}`, { role }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.members });
      void client.invalidateQueries({ queryKey: keys.session });
    },
  });
}

export function useRemoveMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/v1/admin/members/${encodeURIComponent(userId)}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.members }),
  });
}

/**
 * Self-removal. Leaving changes which organization the operator acts in — and
 * may leave them with none, in which case the gateway provisions a fresh
 * default — so every organization-scoped cache is dropped.
 */
export function useLeaveOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/v1/admin/members/${encodeURIComponent(userId)}`),
    onSuccess: () => client.clear(),
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
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.providers }),
  });
}

export function useCreateCfAigPreset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: CfAigPresetBody) =>
      api.post<CfAigPresetResponse>("/v1/admin/providers/cf-aig-preset", body),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.providers }),
  });
}

/** Rotation, rename and pricing edits share one endpoint. */
export function useUpdateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderUpdateBody }) =>
      api.put<ProviderResponse>(`/v1/admin/providers/${encodeURIComponent(id)}`, body),
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.providers }),
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ deleted: true; provider_id: string }>(
        `/v1/admin/providers/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.providers }),
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
