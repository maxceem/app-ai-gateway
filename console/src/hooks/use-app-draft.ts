import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  authIssuer,
  emptyIssuer,
  withIssuer,
  type AuthConfig,
  type AuthenticationConfig,
  type EndpointsConfig,
  type LimitsConfig,
  type ProxyConfig,
  type StoredAppConfig,
} from "@/lib/config-types";
import { useApp, useSaveApp, useValidateApp } from "@/lib/queries";
import type { AppRow, AppUpsertBody } from "@/lib/types";

export interface Draft {
  name: string;
  config: StoredAppConfig;
  status: "active" | "disabled";
}

export function toDraft(row: AppRow): Draft {
  return { name: row.name, config: row.config, status: row.status };
}

const asBody = (draft: Draft): AppUpsertBody => draft;

export function useAppDraft(appId: string) {
  const query = useApp(appId);
  const saveMutation = useSaveApp(appId);
  const validateMutation = useValidateApp(appId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [draftAppId, setDraftAppId] = useState<string | null>(null);
  /**
   * What the issuer held the last time one was configured, so switching the
   * toggle off and back on restores the JWKS URL and claims instead of handing
   * the operator a blank form.
   */
  const lastIssuer = useRef<AuthConfig | null>(null);

  const row = query.data?.app;
  useEffect(() => {
    if (!row) return;
    const next = toDraft(row);
    lastIssuer.current = authIssuer(next.config.authentication) ?? null;
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setDraftAppId(appId);
  }, [appId, row]);

  const activeDraft = draftAppId === appId ? draft : null;
  const activeBaseline = draftAppId === appId ? baseline : null;
  const dirty = activeDraft !== null && activeBaseline !== null && JSON.stringify(activeDraft) !== activeBaseline;

  const update = useCallback((partial: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...partial } : current));
  }, []);

  const updateConfig = useCallback((partial: Partial<StoredAppConfig>) => {
    setDraft((current) => current
      ? { ...current, config: { ...current.config, ...partial } }
      : current);
  }, []);

  const updateAuthentication = useCallback((authentication: AuthenticationConfig) => {
    updateConfig({ authentication });
  }, [updateConfig]);

  const updateIssuer = useCallback((partial: Partial<AuthConfig>) => {
    setDraft((current) => {
      if (!current) return current;
      const authentication = current.config.authentication;
      // An api_key app has no issuer until the operator enables one. An App
      // Attest app always has one, so a config edited into shape without it
      // starts from the defaults the form is already showing.
      const issuer = authIssuer(authentication)
        ?? (authentication.type === "apple_app_attest" ? emptyIssuer() : undefined);
      if (!issuer) return current;
      return {
        ...current,
        config: {
          ...current.config,
          authentication: withIssuer(authentication, { ...issuer, ...partial }),
        },
      };
    });
  }, []);

  /**
   * Turns the optional issuer on an api_key app on and off. Disabling drops the
   * block rather than blanking it, so the saved config matches an app that never
   * had one, while the dropped values are kept in memory for a re-enable.
   */
  const setIssuerEnabled = useCallback((enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const authentication = current.config.authentication;
      const configured = authIssuer(authentication);
      if (configured) lastIssuer.current = configured;
      const issuer = enabled
        ? (configured ?? lastIssuer.current ?? emptyIssuer())
        : undefined;
      return {
        ...current,
        config: { ...current.config, authentication: withIssuer(authentication, issuer) },
      };
    });
  }, []);

  const updateProxy = useCallback((partial: Partial<ProxyConfig>) => {
    setDraft((current) => current
      ? { ...current, config: { ...current.config, routing: { ...current.config.routing, ...partial } } }
      : current);
  }, []);

  const updateLimits = useCallback((limits: LimitsConfig) => updateConfig({ limits }), [updateConfig]);

  // Endpoints live inside config_json, so they ride the same draft as the rest.
  // An empty map is dropped so apps without endpoints keep their config clean.
  const updateEndpoints = useCallback((endpoints: EndpointsConfig) => {
    setDraft((current) => {
      if (!current) return current;
      const { endpoints: _previous, ...config } = current.config;
      return {
        ...current,
        config: Object.keys(endpoints).length === 0 ? config : { ...config, endpoints },
      };
    });
  }, []);

  const reset = useCallback(() => {
    if (!activeBaseline) return;
    const restored = JSON.parse(activeBaseline) as Draft;
    // Discarding also forgets an issuer that only ever existed in the draft.
    lastIssuer.current = authIssuer(restored.config.authentication) ?? null;
    setDraft(restored);
  }, [activeBaseline]);

  const save = useCallback(async () => {
    if (!activeDraft) return false;
    try {
      await saveMutation.mutateAsync(asBody(activeDraft));
      setBaseline(JSON.stringify(activeDraft));
      toast.success("Configuration saved", {
        description: "The gateway picks it up within the 60 second config cache TTL.",
      });
      return true;
    } catch (error) {
      toast.error("Save rejected", { description: error instanceof Error ? error.message : "Unknown error" });
      return false;
    }
  }, [activeDraft, saveMutation]);

  const validate = useCallback(async () => {
    if (!activeDraft) return;
    try {
      await validateMutation.mutateAsync(asBody(activeDraft));
      toast.success("Configuration is valid");
    } catch (error) {
      toast.error("Configuration is invalid", { description: error instanceof Error ? error.message : "Unknown error" });
    }
  }, [activeDraft, validateMutation]);

  return {
    query,
    draft: activeDraft,
    setDraft,
    dirty,
    update,
    updateConfig,
    updateAuthentication,
    updateIssuer,
    setIssuerEnabled,
    updateProxy,
    updateLimits,
    updateEndpoints,
    reset,
    save,
    saving: saveMutation.isPending,
    validate,
    validating: validateMutation.isPending,
  };
}

export type AppDraft = ReturnType<typeof useAppDraft>;
