import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/field";
import type { AppDraft } from "@/hooks/use-app-draft";
import { formatCost } from "@/lib/format";

export function LimitsTab({ state }: { state: AppDraft }) {
  const draft = state.draft!;
  const limits = draft.config.limits;
  const updateScope = (
    scope: "per_user" | "per_app",
    partial: Partial<(typeof limits)["per_user"]>,
  ) => state.updateLimits({
    ...limits,
    [scope]: { ...limits[scope], ...partial },
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Per-user limits</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Applied independently to every authenticated user. Rate limits return{" "}
            <code className="font-mono">rate_limited</code>; exhausting the monthly spend returns{" "}
            <code className="font-mono">budget_exhausted</code>.
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
                      per_minute: event.target.value ? Number(event.target.value) : null,
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
                      per_day: event.target.value ? Number(event.target.value) : null,
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
                  ? `${formatCost(limits.per_user.spending.monthly_usd)} per user per month`
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
                    spending: { monthly_usd: event.target.value ? Number(event.target.value) : null },
                  })
                }
              />
            </Field>
          </div>
        </CardContent>
      </Card>

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
            <Field
              label="Requests per minute"
              htmlFor="app-rpm"
              hint="Leave empty for unlimited."
            >
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
                      per_minute: event.target.value ? Number(event.target.value) : null,
                    },
                  })
                }
              />
            </Field>
            <Field
              label="Requests per day"
              htmlFor="app-rpd"
              hint="Leave empty for unlimited."
            >
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
                      per_day: event.target.value ? Number(event.target.value) : null,
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
                  ? `${formatCost(limits.per_app.spending.monthly_usd)} per application per month`
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
                    spending: { monthly_usd: event.target.value ? Number(event.target.value) : null },
                  })
                }
              />
            </Field>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
