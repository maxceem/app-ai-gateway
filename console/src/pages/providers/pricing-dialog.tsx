import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { PROVIDER_LABELS, reportsCost, type Provider } from "@/lib/config-types";
import { draftsToPricing, toDrafts, type PricingDraft } from "@/lib/pricing-draft";
import { useUpdateProvider } from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";
import { errorMessage } from "./shared";

/**
 * Pricing is ordinary non-secret data, so it is shown and edited normally —
 * none of the write-only handling the credential needs applies here.
 */
export function PricingDialog({
  provider,
  onClose,
  readOnly,
}: {
  provider: ProviderCredential | null;
  onClose: () => void;
  readOnly: boolean;
}) {
  const updateProvider = useUpdateProvider();
  const [drafts, setDrafts] = useState<PricingDraft[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (provider && loadedFor !== provider.id) {
    setLoadedFor(provider.id);
    setDrafts(toDrafts(provider.pricing));
  }

  const setRow = (index: number, patch: Partial<PricingDraft>) => {
    setDrafts((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = async () => {
    if (!provider) return;
    const result = draftsToPricing(drafts);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    try {
      await updateProvider.mutateAsync({
        id: provider.id,
        body: { pricing: Object.keys(result.pricing).length ? result.pricing : null, revision: provider.revision },
      });
      toast.success(`Updated pricing for ${provider.name}`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not save the pricing"));
    }
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) {
          setLoadedFor(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Custom model pricing</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <DialogDescription>
            For models the built-in catalog does not cover, or prices it in a way you disagree with.
            {provider && reportsCost(provider.type)
              ? ` ${PROVIDER_LABELS[provider.type as Provider] ?? provider.type} reports the cost of
                  every request, so its models proxy with no price here; a price entered here is
                  only used if a response ever comes back without one.`
              : " Requests for unpriced models are rejected until a price is set here."}{" "}
            Enter $0 for a model that is genuinely free.
          </DialogDescription>
          {drafts.length === 0 ? (
            <EmptyState>No custom prices for this provider.</EmptyState>
          ) : (
            <>
              {/* One header row instead of a label per input: the rows repeat, so
                  the columns are named once and each field carries its own
                  accessible name. */}
              <div
                aria-hidden
                className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2 text-xs text-muted-foreground"
              >
                <span>Model</span>
                <span>Input $/1M</span>
                <span>Output $/1M</span>
                <span className="w-9" />
              </div>
              {drafts.map((row, index) => (
                <div key={index} className="grid grid-cols-[2fr_1fr_1fr_auto] items-center gap-2">
                  <Input
                    aria-label={`Model ${index + 1}`}
                    value={row.model}
                    placeholder="gpt-brand-new"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { model: event.target.value })}
                  />
                  <Input
                    aria-label={`Input price ${index + 1}`}
                    inputMode="decimal"
                    value={row.input}
                    placeholder="1.25"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { input: event.target.value })}
                  />
                  <Input
                    aria-label={`Output price ${index + 1}`}
                    inputMode="decimal"
                    value={row.output}
                    placeholder="10"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { output: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove pricing row ${index + 1}`}
                    disabled={readOnly}
                    onClick={() =>
                      setDrafts((current) => current.filter((_row, position) => position !== index))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setDrafts((current) => [...current, { model: "", input: "", output: "" }])}
          >
            <Plus className="size-4" />
            Add model
          </Button>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GuardedButton disabled={updateProvider.isPending} onClick={() => void submit()}>
            {updateProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save pricing
          </GuardedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
