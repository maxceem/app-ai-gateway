import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { isUnauthorized } from "./lib/api";
import { keys } from "./lib/queries";
import "./index.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Config screens hold unsaved drafts; a focus refetch would discard them.
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      retry: (count, error) => !isUnauthorized(error) && count < 2,
    },
  },
  // An expired session must drop the whole app back to the login screen rather
  // than leaving every panel showing its own 401.
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) client.setQueryData(keys.session, null);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) client.setQueryData(keys.session, null);
    },
  }),
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
