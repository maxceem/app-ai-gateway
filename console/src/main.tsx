import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { isUnauthorized } from "./lib/api";
import { keys } from "./lib/queries";
import "./index.css";

const AUTH_PATHS = new Set(["/login", "/signup"]);

/**
 * A 401 anywhere means the session is gone. Dropping the cached session sends
 * the router back to the sign-in screen rather than leaving every panel to
 * render its own 401, and the redirect is skipped on the auth screens so a bad
 * password does not look like a navigation.
 */
function handleUnauthorized(error: unknown) {
  if (!isUnauthorized(error)) return;
  client.setQueryData(keys.session, null);
  if (!AUTH_PATHS.has(window.location.pathname)) {
    window.history.pushState({}, "", "/login");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Config screens hold unsaved drafts; a focus refetch would discard them.
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      retry: (count, error) => !isUnauthorized(error) && count < 2,
    },
  },
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
