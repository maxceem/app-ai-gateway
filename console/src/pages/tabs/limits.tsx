import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, Field } from "@/components/field";
import type { AppDraft } from "@/hooks/use-app-draft";
import type { LimitScopeConfig, LimitsConfig } from "@/lib/config-types";
import { formatCost } from "@/lib/format";

/** An app with no `limits` block is unlimited; editing one starts from this. */
const UNLIMITED_SCOPE: LimitScopeConfig = {
  requests: { per_minute: null, per_day: null },
  spending: { monthly_usd: null },
};

const UNLIMITED: LimitsConfig = { per_user: UNLIMITED_SCOPE, per_app: UNLIMITED_SCOPE };

/** Empty means unlimited, so an unparseable or blank field clears the limit. */
const asLimit = (value: string): number | null => (value === "" ? null : Number(value));

export function LimitsTab({ state }: { state: AppDraft }) {
  const draft = state.draft!;
  const limits = draft.config.limits ?? UNLIMITED;
  /*
   * An application that identifies no end users has nobody for a per-user limit
   * to apply to, and the Worker refuses the combination outright. Hiding the
   * card is the honest form of that: the alternative is a form that accepts
   * numbers and then fails on save, or worse, one that looks like it is
   * metering users while everything lands in a single bucket.
   */
  const identifiesUsers = draft.config.authentication.type !== "api_key"
    || draft.config.authentication.end_user !== undefined;
  const updateScope = (scope: "per_user" | "per_app", partial: Partial<LimitScopeConfig>) =>
    state.updateLimits({
      ...limits,
      [scope]: { ...limits[scope], ...partial },
    });

  return (
    <div className="space-y-4">
      {/*
        The distinction this page exists to make. These limits and the plan
        allowance on the billing page are unrelated quotas over different
        populations, and reading one as the other is the mistake that cost this
        feature once already.
      */}
      <p className="text-sm leading-relaxed text-muted-foreground">
        Limits you set on <strong className="font-medium text-foreground">your app's end users</strong>.
        They are unrelated to your own{" "}
        <Link to="/billing" className="text-primary-ink underline underline-offset-4">
          plan allowance
        </Link>
        , which meters all your apps together: a request refused here never spends it. Edits take
        up to a minute to apply everywhere.
      </p>

      <div className={identifiesUsers ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}>
        {identifiesUsers ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Per-user limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Applied independently to every authenticated user. Rate limits return{" "}
              <code className="font-mono">app_rate_limited</code>; exhausting the monthly spend
              returns <code className="font-mono">app_budget_exhausted</code>.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requests per minute" htmlFor="rpm" hint="Leave empty for unlimited.">
                <Input
                  id="rpm"
                  type="number"
                  min={1}
                  value={limits.per_user.requests.per_minute ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_user", {
                      requests: {
                        ...limits.per_user.requests,
                        per_minute: asLimit(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="Requests per day" htmlFor="rpd" hint="Leave empty for unlimited.">
                <Input
                  id="rpd"
                  type="number"
                  min={1}
                  value={limits.per_user.requests.per_day ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_user", {
                      requests: {
                        ...limits.per_user.requests,
                        per_day: asLimit(event.target.value),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <div className="border-t pt-4">
              <Field
                label="Monthly spending budget (USD)"
                htmlFor="budget"
                hint={
                  limits.per_user.spending.monthly_usd !== null
                    ? `${formatCost(limits.per_user.spending.monthly_usd)} per user per month. Settled from completed requests, so it stops the request after the one that crosses it.`
                    : "Unlimited"
                }
              >
                <Input
                  id="budget"
                  type="number"
                  min={0}
                  step="0.01"
                  value={limits.per_user.spending.monthly_usd ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_user", {
                      spending: { monthly_usd: asLimit(event.target.value) },
                    })
                  }
                />
              </Field>
            </div>
          </CardContent>
        </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <EmptyState>
                This application identifies no end users, so there is nobody for a per-user limit to
                apply to. Choose a user authentication method on the Auth policy tab to set them, or
                use the application limits below.
              </EmptyState>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Application limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Shared across all users and credentials for this application. Leave a field empty to
              keep that application-wide limit unrestricted.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requests per minute" htmlFor="app-rpm" hint="Leave empty for unlimited.">
                <Input
                  id="app-rpm"
                  type="number"
                  min={1}
                  value={limits.per_app.requests.per_minute ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_app", {
                      requests: {
                        ...limits.per_app.requests,
                        per_minute: asLimit(event.target.value),
                      },
                    })
                  }
                />
              </Field>
              <Field label="Requests per day" htmlFor="app-rpd" hint="Leave empty for unlimited.">
                <Input
                  id="app-rpd"
                  type="number"
                  min={1}
                  value={limits.per_app.requests.per_day ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_app", {
                      requests: {
                        ...limits.per_app.requests,
                        per_day: asLimit(event.target.value),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <div className="border-t pt-4">
              <Field
                label="Monthly spending budget (USD)"
                htmlFor="app-budget"
                hint={
                  limits.per_app.spending.monthly_usd !== null
                    ? `${formatCost(limits.per_app.spending.monthly_usd)} per application per month. Settled from completed requests, so it stops the request after the one that crosses it.`
                    : "Unlimited"
                }
              >
                <Input
                  id="app-budget"
                  type="number"
                  min={0}
                  step="0.01"
                  value={limits.per_app.spending.monthly_usd ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_app", {
                      spending: { monthly_usd: asLimit(event.target.value) },
                    })
                  }
                />
              </Field>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
