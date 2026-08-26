import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/field";
import { StatCard } from "@/components/stat-card";
import type { AppDraft } from "@/hooks/use-app-draft";
import {
  PROVIDER_LABELS,
  authIssuer,
  enabledProviders,
  providerMode,
} from "@/lib/config-types";
import { currentMonth, formatCompact, formatCost, formatNumber } from "@/lib/format";
import { useMonthlyUsage, useUsers } from "@/lib/queries";

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-1 border-l pl-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-all">{value}</dd>
    </div>
  );
}

export function OverviewTab({ appId, state }: { appId: string; state: AppDraft }) {
  const month = currentMonth();
  const usage = useMonthlyUsage(appId, month);
  const users = useUsers(appId, { month, limit: 1 });
  const draft = state.draft!;
  const resolved = state.query.data?.resolved;
  const authentication = draft.config.authentication;
  const userBudget = draft.config.limits.per_user.spending.monthly_usd;
  const appBudget = draft.config.limits.per_app.spending.monthly_usd;

  const tokens =
    (usage.data?.input_tokens ?? 0) +
    (usage.data?.cached_input_tokens ?? 0) +
    (usage.data?.cache_write_tokens ?? 0) +
    (usage.data?.output_tokens ?? 0);
  const budgetShare = appBudget
    ? (usage.data?.cost_usd ?? 0) / appBudget
    : null;
  // api_key apps only have an issuer when verified user identity is required.
  const issuer = authIssuer(authentication);
  const issuerHost = (() => {
    if (!issuer) return authentication.type === "api_key" ? "API key only" : "not set";
    try {
      return new URL(issuer.jwks_url ?? "").host;
    } catch {
      return "not set";
    }
  })();

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Requests"
          value={formatNumber(usage.data?.requests ?? 0)}
          detail="month to date"
        />
        <StatCard label="Tokens" value={formatCompact(tokens)} detail="all buckets" />
        <StatCard
          label="Cost"
          value={formatCost(usage.data?.cost_usd ?? 0)}
          detail="priced from prices.json"
        />
        <StatCard
          label={appBudget ? "App budget used" : "User budget"}
          value={
            budgetShare !== null
              ? `${Math.round(budgetShare * 100)}%`
              : userBudget
                ? formatCost(userBudget)
                : "—"
          }
          detail={
            appBudget
              ? `${formatCost(appBudget)} app budget`
              : userBudget
                ? "per user per month"
              : "no monthly budget"
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Display name" htmlFor="name">
              <Input
                id="name"
                value={draft.name}
                onChange={(event) => state.update({ name: event.target.value })}
              />
            </Field>
            {authentication.type === "apple_app_attest" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Apple team id"
                htmlFor="team"
                hint="Required for App Attest verification."
              >
                <Input
                  id="team"
                  value={authentication.app_attest.team_id}
                  placeholder="ABCDE12345"
                  className="font-mono text-xs"
                  onChange={(event) => state.updateAuthentication({
                    ...authentication,
                    app_attest: { ...authentication.app_attest, team_id: event.target.value },
                  })}
                />
              </Field>
              <Field label="Apple bundle id" htmlFor="bundle">
                <Input
                  id="bundle"
                  value={authentication.app_attest.bundle_id}
                  placeholder="com.example.app"
                  className="font-mono text-xs"
                  onChange={(event) => state.updateAuthentication({
                    ...authentication,
                    app_attest: { ...authentication.app_attest, bundle_id: event.target.value },
                  })}
                />
              </Field>
            </div>
            ) : null}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">App enabled</p>
                <p className="text-xs text-muted-foreground">
                  Disabling returns <code className="font-mono">app_disabled</code> to every client
                  request.
                </p>
              </div>
              <Switch
                checked={draft.status === "active"}
                onCheckedChange={(checked) =>
                  state.update({ status: checked ? "active" : "disabled" })
                }
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Effective configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label="Issuer" value={issuerHost} />
              <Fact
                label="User id claim"
                value={issuer ? (issuer.user_id_claim ?? "sub") : "x-end-user-id"}
              />
              <Fact
                label="Rate limits"
                value={`${resolved?.limits.perUser.requestsPerMinute ?? "∞"} rpm · ${resolved?.limits.perUser.requestsPerDay ?? "∞"} rpd`}
              />
              <Fact
                label="Issuer token lifetime cap"
                value={issuer
                  ? `${formatNumber(issuer.max_token_lifetime_seconds ?? 86400)} s`
                  : "not applicable"}
              />
              <Fact
                label="Providers"
                value={
                  providerMode(draft.config.routing) === "all"
                    ? "All supported providers"
                    : enabledProviders(draft.config.routing)
                        .map((provider) => PROVIDER_LABELS[provider])
                        .join(", ") || "none"
                }
              />
              <Fact label="Registered users" value={formatNumber(users.data?.total ?? 0)} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Client base URL</CardTitle>
        </CardHeader>
        <CardContent>
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
            {window.location.origin}/v1/apps/{appId}/proxy/&#123;provider&#125;/&#123;provider_path&#125;
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            Auth exchange lives at <span className="font-mono">/v1/apps/{appId}/auth/token</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
