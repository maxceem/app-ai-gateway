import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AlertCircle, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GatewayIcon } from "@/components/brand-icon";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { PageHeader } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { RowAction, RowActions } from "@/components/row-actions";
import { GATEWAY_TYPE_LABELS } from "@/lib/config-types";
import { useDeleteProviderGateway, useProviderGateways } from "@/lib/queries";
import type { ProviderGateway } from "@/lib/types";
import { GatewayDialog } from "./gateway-dialog";
import { RenameGatewayDialog } from "./rename-gateway-dialog";
import { RotateGatewayDialog } from "./rotate-gateway-dialog";
import { GatewayAuth, deleteBlockedReason, errorMessage, gatewayAnchor } from "./shared";

export function GatewaysSection() {
  const list = useProviderGateways();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<ProviderGateway | null>(null);
  const [rotating, setRotating] = useState<ProviderGateway | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderGateway | null>(null);
  const deleteGateway = useDeleteProviderGateway();

  const gateways = list.data?.gateways ?? [];
  const error = list.isError ? list.error : null;

  // A provider's Auth cell links here by anchor, and the rows it points at only
  // exist once the list has loaded — which is after the browser gave up on the
  // fragment. `hash` is in the dependencies so a second visit to the same
  // gateway scrolls again.
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document
      .getElementById(hash.slice(1))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [hash, list.data]);

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      await deleteGateway.mutateAsync(pendingDelete.id);
      toast.success(`Deleted ${pendingDelete.name}`);
      setPendingDelete(null);
    } catch (deleteError) {
      toast.error(errorMessage(deleteError, "Could not delete the gateway"));
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gateways"
        description="Set up the gateways you use to reach AI providers."
        action={
          <GuardedButton size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add gateway
          </GuardedButton>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Could not load gateways</AlertTitle>
          <AlertDescription>{errorMessage(error, "Unknown error")}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="overflow-hidden py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.isPending ? (
              [0, 1].map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : gateways.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  No gateways yet. Add one to route providers through it.
                </TableCell>
              </TableRow>
            ) : (
              gateways.map((row) => (
                <TableRow key={row.id} id={gatewayAnchor(row.id)}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      <GatewayIcon type={row.type} />
                      {GATEWAY_TYPE_LABELS[row.type]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <GatewayAuth gateway={row} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions label={row.name}>
                      <RowAction onSelect={() => setRotating(row)}>
                        <RotateCw />
                        Update token
                      </RowAction>
                      <RowAction onSelect={() => setRenaming(row)}>
                        <Pencil />
                        Rename
                      </RowAction>
                      <DropdownMenuSeparator />
                      <RowAction
                        destructive
                        reason={deleteBlockedReason(row)}
                        onSelect={() => setPendingDelete(row)}
                      >
                        <Trash2 />
                        Delete gateway
                      </RowAction>
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <GatewayDialog open={adding} onOpenChange={setAdding} />
      <RenameGatewayDialog gateway={renaming} onClose={() => setRenaming(null)} />
      <RotateGatewayDialog gateway={rotating} onClose={() => setRotating(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete gateway"
        description={
          <p>
            The stored token for{" "}
            <span className="font-medium text-foreground">{pendingDelete?.name}</span> is destroyed.
            Nothing routes through it, so no traffic changes.
          </p>
        }
        confirmLabel="Delete gateway"
        destructive
        pending={deleteGateway.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
