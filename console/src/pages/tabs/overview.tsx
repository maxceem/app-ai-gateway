import { Link } from "react-router-dom";
import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/stat-card";
import type { AppDraft } from "@/hooks/use-app-draft";
import { useConsoleSession } from "@/lib/console-session";
import { clientApiOrigin } from "@/lib/client-api";
import { authIssuer } from "@/lib/config-types";
import { formatCompact, formatCost, formatNumber } from "@/lib/format";
import { useApiKeys, useMonthlyUsage, useUsers } from "@/lib/queries";

/**
 * What the app did this month, and where its clients send requests. How it is
 * configured is not repeated here: each setting is read where it is decided.
 *
 * The figures are the four the apps list totals, in the same order and with the
 * same words: this page is one row of that list, opened up.
 */
export function OverviewTab({
  appId,
  month,
  state,
}: {
  appId: string;
  month: string;
  state: AppDraft;
}) {
  const { capabilities } = useConsoleSession();
  const usage = useMonthlyUsage(appId, month);
  // One row, for the count beside it: the list's Users figure is every identity
  // the app has ever had, which is why the month does not narrow it.
  const users = useUsers(appId, { month, limit: 1 });
  const draft = state.draft!;
  const authentication = draft.config.authentication;

  const tokens =
    (usage.data?.input_tokens ?? 0) +
    (usage.data?.cached_input_tokens ?? 0) +
    (usage.data?.cache_write_tokens ?? 0) +
    (usage.data?.output_tokens ?? 0);
  const issuer = authIssuer(authentication);

  return (
    <div className="space-y-6">
      {authentication.type === "api_key" ? <NoKeysNotice appId={appId} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Spend"
          value={
            usage.isPending ? <Skeleton className="h-6 w-20" /> : formatCost(usage.data?.cost_usd ?? 0)
          }
          detail="month to date"
        />
        <StatCard
          label="Users"
          value={
            users.isPending ? <Skeleton className="h-6 w-12" /> : formatNumber(users.data?.total ?? 0)
          }
          detail="all time"
        />
        <StatCard
          label="Requests"
          value={
            usage.isPending ? <Skeleton className="h-6 w-16" /> : formatNumber(usage.data?.requests ?? 0)
          }
          detail="month to date"
        />
        <StatCard
          label="Tokens"
          value={usage.isPending ? <Skeleton className="h-6 w-16" /> : formatCompact(tokens)}
          detail="all buckets"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Client base URL</CardTitle>
        </CardHeader>
        <CardContent>
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
            {clientApiOrigin(capabilities)}/v1/apps/{appId}/proxy/&#123;provider&#125;/&#123;provider_path&#125;
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            {issuer ? (
              <>
                Auth exchange lives at{" "}
                <span className="font-mono">/v1/apps/{appId}/auth/token</span>.
              </>
            ) : (
              <>
                Clients send their API key as the{" "}
                <span className="font-mono">Authorization</span> bearer credential; this app has no
                token exchange.
              </>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The one state that stops a server app's traffic without any other sign of
 * it: no key has been issued, or every key was revoked. Said once, here, with
 * the way to fix it; silent otherwise.
 */
function NoKeysNotice({ appId }: { appId: string }) {
  const keys = useApiKeys(appId);
  if (!keys.data || keys.data.keys.some((key) => key.status === "active")) return null;

  return (
    <Alert>
      <KeyRound />
      <AlertTitle>This app has no active API key</AlertTitle>
      <AlertDescription>
        Nothing can call it until one is created.{" "}
        <Link to={`/apps/${appId}/auth/identity`} className="text-primary-ink underline underline-offset-4">
          Create an API key
        </Link>
      </AlertDescription>
    </Alert>
  );
}
