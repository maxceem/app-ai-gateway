import { useState } from "react";
import {
  AlertCircle,
  CircleDollarSign,
  CirclePlay,
  CircleSlash,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProviderIcon } from "@/components/brand-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { RowAction, RowActions } from "@/components/row-actions";
import { useConsoleSession } from "@/lib/console-session";
import { PROVIDER_LABELS } from "@/lib/config-types";
import { currentMonth } from "@/lib/format";
import {
  useApps,
  useDeleteProvider,
  useProviderGateways,
  useProviders,
  useUpdateProvider,
} from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";
import { AddProviderDialog } from "./add-provider-dialog";
import { PricingDialog } from "./pricing-dialog";
import { RotateDialog } from "./rotate-dialog";
import { Auth, DisabledBadge, ReferencingApps, errorMessage } from "./shared";

export function ProvidersSection() {
  const { readOnly } = useConsoleSession();
  const list = useProviders();
  // The gateways are read here for the Auth column, which names the gateway a
  // routed instance borrows its token from.
  const gatewayList = useProviderGateways();
  const deleteProvider = useDeleteProvider();
  const updateProvider = useUpdateProvider();
  // Informational only: the warning names the apps that will notice, and both
  // the disable and the delete go through regardless of what it finds.
  const appList = useApps(currentMonth());

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProviderCredential | null>(null);
  const [rotating, setRotating] = useState<ProviderCredential | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderCredential | null>(null);
  const [pendingDisable, setPendingDisable] = useState<ProviderCredential | null>(null);

  const providers = list.data?.providers ?? [];
  const gateways = gatewayList.data?.gateways ?? [];

  const referencingApps = (slug: string): string[] =>
    (appList.data?.apps ?? [])
      .filter((row) => row.referenced_providers.includes(slug))
      .map((row) => row.name);

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await deleteProvider.mutateAsync(pendingDelete.id);
      toast.success(`Deleted ${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (error) {
      toast.error(errorMessage(error, "Could not delete the provider"));
    }
  };

  const disable = async () => {
    if (!pendingDisable) return;
    try {
      await updateProvider.mutateAsync({ id: pendingDisable.id, body: { status: "disabled", revision: pendingDisable.revision } });
      toast.success(`Disabled ${pendingDisable.name}`);
      setPendingDisable(null);
    } catch (error) {
      toast.error(errorMessage(error, "Could not disable the provider"));
    }
  };

  /**
   * Enabling needs no dialog: the row kept its slug, so nothing can be standing
   * in the way and this only ever restores traffic. A failed request is still
   * worth reporting in the server's own words.
   */
  const enable = async (row: ProviderCredential) => {
    try {
      await updateProvider.mutateAsync({ id: row.id, body: { status: "active", revision: row.revision } });
      toast.success(`Enabled ${row.name}`);
    } catch (error) {
      toast.error(errorMessage(error, "Could not enable the provider"));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        description="Set up the AI providers your apps use."
        action={
          <GuardedButton size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add provider
          </GuardedButton>
        }
      />

      {list.isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load providers</AlertTitle>
          <AlertDescription>{errorMessage(list.error, "Unknown error")}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1, 2].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No providers yet. Add a key per provider, or route one through a gateway.
                </TableCell>
              </TableRow>
            ) : (
              providers.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      {row.name}
                      {row.status === "disabled" ? <DisabledBadge /> : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      <ProviderIcon type={row.type} />
                      {PROVIDER_LABELS[row.type]}
                    </Badge>
                  </TableCell>
                  {/* The slug is a URL segment, so it is shown exactly as typed. */}
                  <TableCell className="font-mono text-xs">{row.slug}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <Auth row={row} gateways={gateways} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions label={row.name}>
                      {/* Pricing is readable by anyone; its dialog guards the save. */}
                      <DropdownMenuItem onSelect={() => setEditing(row)}>
                        <CircleDollarSign />
                        Pricing
                      </DropdownMenuItem>
                      <RowAction
                        reason={
                          row.providerGatewayId === null
                            ? undefined
                            : "This instance authenticates with the gateway token — update the gateway's token instead"
                        }
                        onSelect={() => setRotating(row)}
                      >
                        <RotateCw />
                        Update key
                      </RowAction>
                      <DropdownMenuSeparator />
                      {row.status === "disabled" ? (
                        <RowAction onSelect={() => void enable(row)}>
                          <CirclePlay />
                          Enable provider
                        </RowAction>
                      ) : (
                        <RowAction onSelect={() => setPendingDisable(row)}>
                          <CircleSlash />
                          Disable provider
                        </RowAction>
                      )}
                      <RowAction destructive onSelect={() => setPendingDelete(row)}>
                        <Trash2 />
                        Delete provider
                      </RowAction>
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <AddProviderDialog
        open={adding}
        onOpenChange={setAdding}
        providers={providers}
        gateways={gateways}
      />
      {/* Keyed by the row, so each provider gets a fresh dialog whose fields
          start from that row's stored values. */}
      <RotateDialog
        key={rotating?.id}
        provider={rotating}
        onClose={() => setRotating(null)}
      />
      <PricingDialog provider={editing} onClose={() => setEditing(null)} readOnly={readOnly} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete provider"
        description={
          <>
            <p>
              Apps using{" "}
              <span className="font-medium text-foreground">
                {pendingDelete ? PROVIDER_LABELS[pendingDelete.type] : ""}
              </span>{" "}
              start failing within a minute, and any custom pricing on this provider is deleted with
              it.
            </p>
            {pendingDelete ? (
              <ReferencingApps
                slug={pendingDelete.slug}
                names={referencingApps(pendingDelete.slug)}
              />
            ) : null}
            <p>
              This cannot be undone. Update the key instead if you only want to replace it, or
              disable the provider to pause it and keep the key.
            </p>
          </>
        }
        confirmLabel="Delete provider"
        destructive
        pending={deleteProvider.isPending}
        onConfirm={() => void remove()}
      />

      <ConfirmDialog
        open={pendingDisable !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisable(null);
        }}
        title="Disable provider"
        description={
          <>
            <p>
              Requests to{" "}
              <span className="font-mono text-foreground">{pendingDisable?.slug ?? ""}</span> start
              failing within a minute.
            </p>
            {pendingDisable ? (
              <ReferencingApps
                slug={pendingDisable.slug}
                names={referencingApps(pendingDisable.slug)}
              />
            ) : null}
          </>
        }
        confirmLabel="Disable provider"
        pending={updateProvider.isPending}
        onConfirm={() => void disable()}
      />
    </div>
  );
}
