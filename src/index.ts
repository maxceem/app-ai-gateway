import { Hono } from "hono";
import { GatewayError } from "./core/errors";
import { log } from "./core/log";
import { UserLimiter } from "./do/UserLimiter";
import { adminAuth, type AdminVariables } from "./middleware/admin";
import { gatewayAuth, type GatewayVariables } from "./middleware/auth";
import { limiterGate } from "./middleware/gate";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { operatorAuthRoutes } from "./routes/operator-auth";
import {
  endpointPrepare,
  endpointRoutes,
  type EndpointVariables,
} from "./routes/endpoints";
import { meRoutes } from "./routes/me";
import { proxyPrepare, proxyRoutes, type ProxyVariables } from "./routes/proxy";

export { UserLimiter };

const app = new Hono<{
  Bindings: Env;
  Variables: GatewayVariables & AdminVariables & ProxyVariables & EndpointVariables;
}>();

app.get("/v1/healthz", (c) => c.json({ ok: true, service: "ai-gateway" }));

app.route("/v1/auth", operatorAuthRoutes);

app.route("/v1/apps/:app/auth", authRoutes);

app.use("/v1/apps/:app/proxy/:provider/*", gatewayAuth, proxyPrepare, limiterGate);
app.route("/v1/apps/:app/proxy", proxyRoutes);

app.use("/v1/apps/:app/endpoints/:slug", gatewayAuth, endpointPrepare, limiterGate);
app.route("/v1/apps/:app/endpoints", endpointRoutes);

app.use("/v1/apps/:app/me", gatewayAuth);
app.route("/v1/apps/:app/me", meRoutes);

app.use("/v1/admin/*", adminAuth);
app.route("/v1/admin", adminRoutes);

app.notFound((c) => c.json({ error: { code: "invalid_request", message: "Route not found" } }, 404));

app.onError((error, c) => {
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=UTF-8");
  if (c.req.path.includes("/proxy/") || c.req.path.includes("/endpoints/")) {
    const auth = c.get("authDurationMs") ?? 0;
    const limiter = c.get("limiterDurationMs") ?? 0;
    headers.set(
      "server-timing",
      `auth;dur=${auth.toFixed(1)}, limiter;dur=${limiter.toFixed(1)}, provider_ttfb;dur=0.0`,
    );
  }
  if (error instanceof GatewayError) {
    new Headers(error.headers).forEach((value, name) => headers.set(name, value));
    return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
      status: error.status,
      headers,
    });
  }
  log("error", "unhandled_error", {
    path: c.req.path,
    method: c.req.method,
    error: error instanceof Error ? error.message : String(error),
  });
  return new Response(JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }), {
    status: 500,
    headers,
  });
});

export default app;
