import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalHint } from "@/components/external-hint";
import { GuardedButton } from "@/components/guarded-button";
import { NewAppDialog } from "@/pages/new-app-dialog";
import { AddProviderButton } from "@/pages/providers";
import { clientApiOrigin } from "@/lib/client-api";
import { useConsoleSession } from "@/lib/console-session";
import { currentMonth } from "@/lib/format";
import { useApp, useApps, usePrices, useProviders } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  curlSnippet,
  exampleNotes,
  firstRequest,
  ISSUER_TOKEN_NOTE,
  swiftSignsInUsers,
  swiftSnippet,
} from "@shared/first-request";
import type { AppSummary } from "@/lib/types";

/** Where the docs walk through the first proxied request end to end. */
const QUICKSTART_URL = "https://docs.appaigateway.com/quickstart/";
/** The Swift package guide: adding it, choosing an auth mode, sending a request. */
const IOS_GUIDE_URL = "https://docs.appaigateway.com/integrate/ios/";
/** What an iOS app adds in Xcode before the example compiles. */
const SWIFT_PACKAGE_URL = "https://github.com/maxceem/app-ai-gateway-swift";

/** How long the checklist waits between looks for the first proxied request. */
const FIRST_REQUEST_POLL_MS = 15_000;

/**
 * One row of the checklist: its number, what to do, and the control that does
 * it, or a check in the control's place once it is done.
 *
 * A finished step keeps its place and its number rather than folding away, so
 * someone coming back to the rail sees what they have done as readily as what
 * is left. Its control goes, though: there is nothing left for it to do.
 */
function Step({
  index,
  label,
  done,
  completedLabel,
  action,
  children,
}: {
  index: number;
  label: string;
  done: boolean;
  completedLabel: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 px-1 py-1">
      <span aria-hidden className="w-3 text-right text-xs font-semibold text-muted-foreground tabular">
        {index}
      </span>
      <span className={cn("truncate text-sm font-medium", done && "text-muted-foreground")}>
        {label}
      </span>
      <span className="flex h-6 shrink-0 items-center">
        {done ? (
          <span role="img" aria-label={completedLabel} className="flex size-6 items-center justify-center text-primary">
            <Check className="size-4" aria-hidden />
          </span>
        ) : (
          action
        )}
      </span>
      {children ? <div className="col-span-2 col-start-2 min-w-0">{children}</div> : null}
    </li>
  );
}

/**
 * The third step's state for as long as the checklist exists.
 *
 * Nothing in the console can complete it — it is finished by traffic arriving
 * from an application — so it never renders as done: the whole block goes the
 * moment the first request lands. Until then it says it is watching, which is
 * true; the list behind it is polled.
 */
function WaitingForRequest() {
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-label="Waiting for your first request"
    >
      <span className="relative flex size-2" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      Waiting for the first request…
    </p>
  );
}

/** The example, with a button that puts it on the clipboard. */
function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy the example");
    }
  };

  return (
    <div className="relative min-w-0 overflow-hidden rounded-lg border bg-muted/40">
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="absolute top-2 right-2 bg-background"
        onClick={() => void copy()}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
      <pre className="overflow-x-auto p-4 pr-24 text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

/**
 * The first request the oldest app can send, as code, with as much of a guide
 * as pasting it needs. The example is the same one the CLI prints — see
 * `@shared/first-request` — built from the app's own routing and the catalog,
 * so a restricted app gets a request inside its own allowlist.
 */
function CodeExample({ app, onClose }: { app: AppSummary; onClose: () => void }) {
  const { capabilities } = useConsoleSession();
  const details = useApp(app.id);
  const providers = useProviders();
  const prices = usePrices();
  const ios = app.authentication_type === "apple_app_attest";
  if (details.isPending || providers.isPending || prices.isPending) {
    return <Skeleton className="h-48" />;
  }
  const config = details.data?.app.config;
  const example = firstRequest(
    config?.routing,
    providers.data?.providers ?? [],
    prices.data?.prices ?? {},
  );
  // The host applications call, which on a deployment that publishes a separate
  // API domain is not the console's own. A snippet is pasted into a real app.
  const origin = clientApiOrigin(capabilities);
  const code = ios
    ? swiftSnippet({ baseUrl: origin, appId: app.id, example, authentication: config?.authentication })
    : curlSnippet({ baseUrl: origin, appId: app.id, example, keyExpression: "API_KEY" });
  const notes = [
    ...(ios && swiftSignsInUsers(config?.authentication) ? [ISSUER_TOKEN_NOTE] : []),
    ...exampleNotes(example),
  ];

  return (
    <>
      {ios ? (
        <>
          <DialogDescription className="text-pretty">
            Run this in your iOS app on a real device: App Attest does not work in the simulator.
          </DialogDescription>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              In Xcode choose <strong className="font-medium text-foreground">File → Add Package Dependencies</strong> and
              enter <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">{SWIFT_PACKAGE_URL}</code>.
            </li>
            <li>
              Add the <strong className="font-medium text-foreground">AppAIGateway</strong> product to your target, then
              run this:
            </li>
          </ol>
        </>
      ) : (
        <DialogDescription className="text-pretty">
          Run this from a terminal. Replace <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">API_KEY</code> with{" "}
          <Link
            className="text-primary-ink underline underline-offset-4"
            to={`/apps/${encodeURIComponent(app.id)}/auth/identity`}
            onClick={onClose}
          >
            your API key
          </Link>
          .
        </DialogDescription>
      )}
      <CodeBlock code={code.trimEnd()} />
      {notes.map((note) => (
        <p key={note} className="text-sm text-pretty text-muted-foreground">{note}</p>
      ))}
      <p className="text-sm text-muted-foreground">
        <ExternalHint href={ios ? IOS_GUIDE_URL : QUICKSTART_URL}>
          {ios ? "iOS integration guide" : "Quickstart guide"}
        </ExternalHint>
      </p>
    </>
  );
}

/**
 * The first-run checklist, in the rail until the organization's first request
 * lands.
 *
 * It lives beside every page rather than on one of them: the step that is left
 * after an app is created is finished from inside that app, and the apps list
 * should not have to compete with a card for the operator's eye. Every step
 * the console can do is done from here, through the same modals the pages use.
 * Completion is read from the data rather than remembered — the organization
 * has a provider, has an app, has sent traffic — so it is right for an operator
 * who did any of it elsewhere, or who is the second person to arrive.
 *
 * `has_proxied_requests` is month-independent and never returns to false, so
 * this cannot come back on the first of a month or after a quiet one.
 */
export function GettingStarted() {
  /*
   * The checklist retires on the organization's first proxied request, which
   * nothing in the console can cause. So while it is up the list is polled:
   * the operator's next act is to run their app, and coming back to a rail that
   * still says "waiting" would suggest the request never arrived. Read from the
   * previous render's data, so the poll stops on the same answer that retires
   * the block.
   */
  const waiting = useRef(false);
  const apps = useApps(currentMonth(), waiting.current ? FIRST_REQUEST_POLL_MS : undefined);
  const firstRun = apps.isSuccess && apps.data.has_proxied_requests === false;
  waiting.current = firstRun;
  // Step one's own state, asked for only while the block is up. The
  // add-provider modal invalidates the same key, so finishing that step ticks
  // it here.
  const providers = useProviders(firstRun);
  const [exampleOpen, setExampleOpen] = useState(false);

  if (!firstRun) return null;

  const hasProvider = (providers.data?.providers.length ?? 0) > 0;
  const firstApp = apps.data.apps.reduce<AppSummary | undefined>(
    (first, app) => (!first || app.created_at < first.created_at ? app : first),
    undefined,
  );
  const ready = hasProvider && firstApp !== undefined;

  return (
    // A card rather than a section of the rail: the rail's sections are
    // permanent, and this one is passing through.
    <section
      aria-label="Start in 3 steps"
      className="mx-3 mb-3 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-2 py-2.5"
    >
      <h2 className="px-1 pb-1.5 text-xs font-semibold text-muted-foreground">Start in 3 steps</h2>
      <ol>
        <Step
          index={1}
          label="Add provider"
          done={hasProvider}
          completedLabel="Provider added"
          action={<AddProviderButton size="xs" label="Add" />}
        />
        <Step
          index={2}
          label="Create app"
          done={firstApp !== undefined}
          completedLabel="App created"
          action={<NewAppDialog trigger={<GuardedButton size="xs">Create</GuardedButton>} />}
        />
        <Step index={3} label="Send a request" done={false} completedLabel="Received">
          {ready ? (
            <div className="space-y-2">
              <Button size="xs" variant="outline" onClick={() => setExampleOpen(true)}>
                Show code example
              </Button>
              <WaitingForRequest />
            </div>
          ) : (
            <Button asChild size="xs" variant="outline">
              <a href={QUICKSTART_URL} target="_blank" rel="noopener">
                Quickstart
                <ExternalLink />
              </a>
            </Button>
          )}
        </Step>
      </ol>

      {firstApp ? (
        <Dialog open={exampleOpen} onOpenChange={setExampleOpen}>
          <DialogContent className="sm:max-w-2xl" dismissOnOutsideInteraction>
            <DialogHeader>
              <DialogTitle>Send your first request</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <CodeExample app={firstApp} onClose={() => setExampleOpen(false)} />
            </DialogBody>
            <DialogFooter showCloseButton />
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
