import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import App from "./App";
import { CONSOLE_BASE } from "./lib/auth-redirect";
import { createConsoleQueryClient } from "./lib/query-client";
import "./index.css";

const client = createConsoleQueryClient();

// One data router around the whole console: the screens still declare their
// routes with `<Routes>`, and the router is what lets a page with unsaved
// changes stop a navigation to ask about them. Every route is below `/v2`.
const router = createBrowserRouter([{ path: "*", element: <App /> }], { basename: CONSOLE_BASE });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
