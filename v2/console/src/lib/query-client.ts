import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isPaymentRequired, isUnauthorized } from "./api";
import { AUTH_PATHS, isRetryableError, loginUrlFor } from "./auth-redirect";
import { keys } from "./queries";

export interface ConsoleQueryClientOptions {
  /** Navigates to the sign-in screen. Injected so the behaviour is testable. */
  redirectToLogin?: (url: string) => void;
  /** The operator's current location, used to build the return path. */
  currentPath?: () => { pathname: string; search: string };
}

function browserRedirect(url: string) {
  window.history.pushState({}, "", url);
  // React Router's declarative API listens for history events rather than
  // pushes, so the navigation has to be announced explicitly.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function browserPath() {
  return { pathname: window.location.pathname, search: window.location.search };
}

/**
 * The console's shared query client.
 *
 * Two server answers are handled globally because any request can produce them
 * and every screen would otherwise have to repeat the same handling:
 *
 * - 401: the session is gone, so the cached session is dropped and the operator
 *   is returned to sign-in with their destination preserved.
 * - 402: the organization's subscription lapsed mid-session. Refreshing billing
 *   status makes the banner appear promptly instead of on the next full reload.
 */
export function createConsoleQueryClient(options: ConsoleQueryClientOptions = {}): QueryClient {
  const redirectToLogin = options.redirectToLogin ?? browserRedirect;
  const currentPath = options.currentPath ?? browserPath;

  const handleError = (error: unknown) => {
    if (isPaymentRequired(error)) {
      void client.invalidateQueries({ queryKey: keys.billingStatus });
      return;
    }
    if (!isUnauthorized(error)) return;

    client.setQueryData(keys.session, null);
    const { pathname, search } = currentPath();
    // A rejected password must not look like a navigation.
    if (AUTH_PATHS.has(pathname)) return;
    redirectToLogin(loginUrlFor(`${pathname}${search}`));
  };

  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Config screens hold unsaved drafts; a focus refetch would discard them.
        refetchOnWindowFocus: false,
        staleTime: 10_000,
        retry: (count, error) => isRetryableError(error) && count < 2,
      },
    },
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({ onError: handleError }),
  });

  return client;
}
