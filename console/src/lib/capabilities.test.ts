import { describe, expect, it } from "vitest";
import {
  API_STYLE_PATHS,
  type ApiStyle as CoreApiStyle,
} from "@shared/capabilities";
import { GATEWAY_DESCRIPTORS } from "@shared/gateways";
import { PROVIDER_TYPES, providerCapability } from "@shared/providers";
import { API_STYLE_LABELS, routedSurface } from "./capabilities";
import { providerLabel } from "./config-types";
import { served } from "@/test/providers";

/**
 * The console used to hand-mirror the capability matrix: its own provider list,
 * its own cost-reporting list, its own copy of both gateways' route tables.
 * Every one of them could drift from the backend that enforces it, and a console
 * that offers a combination the server refuses is a bug report.
 *
 * They are gone; what is left is presentation. These assertions are what keep
 * presentation complete — a table this console shows must cover the shared
 * tables it renders, or an entry appears as `undefined`.
 */
describe("the console's view of the shared capability matrix", () => {
  it("labels every API style that has a path to show", () => {
    // The path table is what the console renders as "how to call this", so a
    // style with a path and no label would render a blank row.
    for (const style of Object.keys(API_STYLE_PATHS) as CoreApiStyle[]) {
      expect([style, typeof API_STYLE_LABELS[style as keyof typeof API_STYLE_LABELS]])
        .toEqual([style, "string"]);
    }
    // And nothing is labelled that has no path to put beside it.
    expect(Object.keys(API_STYLE_LABELS).sort()).toEqual(Object.keys(API_STYLE_PATHS).sort());
  });

  it("says nothing extra for a direct row or a gateway that narrows nothing", () => {
    expect(routedSurface({ type: "openai", ...served("openai") })).toBeNull();
    // Cloudflare forwards to the provider's own API, so the console makes no
    // claim about which APIs survive and the provider's own hint stands.
    expect(routedSurface({ type: "openai", ...served("openai", "cf_aig") })).toBeNull();
  });

  it("reads a narrowing route's APIs and model namespace off the instance", () => {
    // Vercel republishes three APIs in front of every model and namespaces the
    // model IDs — both as the gateway reports them on the row.
    const vercel = routedSurface({ type: "gemini", ...served("gemini", "vercel") })!;
    expect(vercel.available.map((entry) => entry.style))
      .toEqual(GATEWAY_DESCRIPTORS.vercel.routes.gemini!.apiStyles);
    expect(vercel.modelIds).toContain("google/");
    expect(vercel.modelIds).toContain(providerLabel("gemini"));
  });

  it("describes a capability for every provider type the shared list admits", () => {
    for (const provider of PROVIDER_TYPES) {
      expect([provider, providerCapability(provider).apiStyles.length > 0])
        .toEqual([provider, true]);
    }
  });
});
