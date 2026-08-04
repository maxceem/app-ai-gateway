import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, query } from "./api";
import type {
  AppListResponse,
  AppCreateBody,
  AppResponse,
  AppUpsertBody,
  ApiKeyListResponse,
  CreatedApiKey,
  CreatedApp,
  CreatedDevelopmentCredential,
  DevelopmentCredential,
  BreakdownResponse,
  EventsResponse,
  MonthlyUsage,
  PricesResponse,
  Session,
  TimeseriesResponse,
  UserListResponse,
} from "./types";

export const keys = {
  session: ["session"] as const,
  apps: (month: string) => ["apps", month] as const,
  app: (appId: string) => ["app", appId] as const,
  apiKeys: (appId: string) => ["api-keys", appId] as const,
  developmentCredential: (appId: string) => ["development-credential", appId] as const,
  users: (appId: string, params: unknown) => ["users", appId, params] as const,
  usage: (appId: string, month: string) => ["usage", appId, month] as const,
  timeseries: (appId: string, from: string, to: string) => ["timeseries", appId, from, to] as const,
  breakdown: (appId: string, by: string, from: string, to: string) =>
    ["breakdown", appId, by, from, to] as const,
  events: (appId: string, params: unknown) => ["events", appId, params] as const,
  prices: ["prices"] as const,
};

export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => api.get<Session>("/v1/console/session"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.post<Session>("/v1/console/session", { token }),
    onSuccess: (session) => client.setQueryData(keys.session, session),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ authenticated: false }>("/v1/console/session"),
    onSuccess: () => client.clear(),
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

export function useDevelopmentCredential(appId: string, enabled = true) {
  return useQuery({
    queryKey: keys.developmentCredential(appId),
    queryFn: () => api.get<DevelopmentCredential>(
      `/v1/admin/apps/${encodeURIComponent(appId)}/development-credential`,
    ),
    enabled,
  });
}

export function useCreateDevelopmentCredential(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CreatedDevelopmentCredential>(
      `/v1/admin/apps/${encodeURIComponent(appId)}/development-credential`,
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.app(appId) });
      void client.invalidateQueries({ queryKey: keys.developmentCredential(appId) });
    },
  });
}

export function useRotateDevelopmentCredential(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CreatedDevelopmentCredential>(
      `/v1/admin/apps/${encodeURIComponent(appId)}/development-credential/rotate`,
    ),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.developmentCredential(appId) }),
  });
}

export function useDeleteDevelopmentCredential(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ enabled: false }>(
      `/v1/admin/apps/${encodeURIComponent(appId)}/development-credential`,
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.app(appId) });
      void client.invalidateQueries({ queryKey: keys.developmentCredential(appId) });
    },
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
