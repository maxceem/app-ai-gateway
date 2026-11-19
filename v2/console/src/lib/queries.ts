import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OperationRequest } from "@contracts/catalog";
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
