import { Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/field";
import type { AppDraft } from "@/hooks/use-app-draft";
import { draftLimits, type LimitsConfig } from "@/lib/config-types";
import { identifiesEndUsers } from "@shared/app-config";
import { formatCost } from "@/lib/format";

/** Empty means unlimited, so an unparseable or blank field clears the limit. */
const asLimit = (value: string): number | null => (value === "" ? null : Number(value));

export function LimitsTab({ appId, state }: { appId: string; state: AppDraft }) {
  const draft = state.draft!;
  const limits = draftLimits(draft.config.limits);
  /*
   * An application that identifies no end users has nobody for a per-user limit
   * to apply to, and the Worker refuses the combination outright. The card
   * stays, so the page always has the same shape, but its fields are disabled
   * and a notice at its top says what turns them on. A form that accepted
   * numbers here would fail on save, or worse, look like it was metering users
   * while everything landed in a single bucket.
   */
  const identifiesUsers = identifiesEndUsers(draft.config.authentication);
  /*
   * An App Attest application's callers are installs — one copy of the app on
   * one device — so its request limits count per install, and so does its
   * budget unless it is moved to the signed-in user, which only an issuer
   * gives a meaning of its own. The JSON key stays `per_user` either way.
   */
  const authentication = draft.config.authentication;
  const perInstall = authentication.type === "apple_app_attest";
  const userScopeAllowed = perInstall && authentication.end_user.source === "issuer";
  const budgetScope = perInstall ? (limits.per_user.spending.scope ?? "install") : "user";
  const updateScope = <K extends "per_user" | "per_app">(scope: K, partial: Partial<LimitsConfig[K]>) =>
    state.updateLimits({
      ...limits,
      [scope]: { ...limits[scope], ...partial },
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{perInstall ? "Per-install limits" : "Per-user limits"}</CardTitle>
            {perInstall ? (
              <p className="text-xs text-muted-foreground">
                Counted for each install: one copy of the app on one device. Reinstalling the app starts a new one.
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requests per minute" htmlFor="rpm">
                <Input
                  id="rpm"
                  type="number"
                  disabled={!identifiesUsers}
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
              <Field label="Requests per day" htmlFor="rpd">
                <Input
                  id="rpd"
                  type="number"
                  disabled={!identifiesUsers}
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
            <div className="space-y-4 border-t pt-4">
              <Field
                label="Monthly spending budget (USD)"
                htmlFor="budget"
                hint={
                  limits.per_user.spending.monthly_usd !== null
                    ? `${formatCost(limits.per_user.spending.monthly_usd)} per ${budgetScope} per month. Settled from completed requests, so it stops the request after the one that crosses it.`
                    : undefined
                }
              >
                <Input
                  id="budget"
                  type="number"
                  disabled={!identifiesUsers}
                  min={0}
                  step="0.01"
                  value={limits.per_user.spending.monthly_usd ?? ""}
                  placeholder="Unlimited"
                  onChange={(event) =>
                    updateScope("per_user", {
                      // The scope rides along: it is the same budget, re-sized.
                      spending: { ...limits.per_user.spending, monthly_usd: asLimit(event.target.value) },
                    })
                  }
                />
              </Field>
              {perInstall ? (
                <Field
                  label="Budget measured per"
                  htmlFor="budget-scope"
                  hint={
                    userScopeAllowed
                      ? "Per user adds up every install of one signed-in person."
                      : "Per user needs sign-in through an identity provider; under app installation every install is its own user."
                  }
                >
                  <Select
                    value={budgetScope}
                    onValueChange={(next) =>
                      updateScope("per_user", {
                        spending: { ...limits.per_user.spending, scope: next as "install" | "user" },
                      })
                    }
                  >
                    <SelectTrigger id="budget-scope" className="w-[180px]" size="sm" aria-label="Budget measured per">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="install">Install</SelectItem>
                      <SelectItem value="user" disabled={!userScopeAllowed}>User</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              ) : null}
            </div>
            {identifiesUsers ? null : (
              <Alert role="status">
                <TriangleAlert />
                <AlertDescription>
                  {/* One paragraph: the description is a grid, and would put
                      the link on a line of its own otherwise. */}
                  <p>
                    Per-user limits cannot be set.{" "}
                    <Link
                      to={`/apps/${appId}/auth/users`}
                      className="text-primary-ink underline underline-offset-4"
                    >
                      Turn on user authentication
                    </Link>{" "}
                    to use them.
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Per-app limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Requests per minute" htmlFor="app-rpm">
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
              <Field label="Requests per day" htmlFor="app-rpd">
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
                    : undefined
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
