import { describe, expect, it } from "vitest";
import {
  API_STYLE_PATHS,
  GATEWAY_ROUTES,
  GATEWAY_TYPES,
  PROVIDER_TYPES,
  providerCapability,
  type ApiStyle as CoreApiStyle,
} from "@shared/capabilities";
import { API_STYLE_LABELS, gatewayApiSurface, routeServesEndpointStyle } from "./capabilities";
import { GATEWAY_TYPE_LABELS, PROVIDER_LABELS } from "./config-types";

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
  it("labels every gateway type that has an adapter", () => {
    for (const type of GATEWAY_TYPES) {
      expect([type, typeof GATEWAY_TYPE_LABELS[type]]).toEqual([type, "string"]);
    }
    expect(Object.keys(GATEWAY_TYPE_LABELS).sort()).toEqual([...GATEWAY_TYPES].sort());
  });

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

  it("describes exactly the routes the shared table serves, and no others", () => {
    for (const gateway of GATEWAY_TYPES) {
      for (const provider of PROVIDER_TYPES) {
        const served = GATEWAY_ROUTES[gateway][provider] !== undefined;
        expect([gateway, provider, gatewayApiSurface(gateway, provider) !== null])
          .toEqual([gateway, provider, served]);
      }
    }
  });

  it("reads each route's narrowing off the shared table", () => {
    // Cloudflare forwards to the provider's own API, so nothing is narrowed and
    // the console makes no claim about which APIs survive.
    const cf = gatewayApiSurface("cf_aig", "openai")!;
    expect(cf.narrowed).toBe(false);
    expect(cf.available).toEqual([]);

    // Vercel republishes three APIs in front of every model, and namespaces the
    // model IDs — both read from the same entry the adapter routes with.
    const vercel = gatewayApiSurface("vercel", "gemini")!;
    expect(vercel.narrowed).toBe(true);
    expect(vercel.available.map((entry) => entry.style))
      .toEqual(GATEWAY_ROUTES.vercel.gemini!.apiStyles);
    // The API Gemini has that this route cannot carry is named, not hidden.
    expect(vercel.unavailable.map((entry) => entry.style)).toEqual(["gemini_native"]);
    expect(vercel.modelIds).toContain("google/");
    expect(vercel.modelIds).toContain(PROVIDER_LABELS.gemini);
  });

  it("judges endpoint eligibility by the route, not the provider type", () => {
    // Both styles on the provider's own API; only Responses through Vercel.
    for (const style of ["responses", "transcription"] as const) {
      expect([style, routeServesEndpointStyle(null, "openai", style)]).toEqual([style, true]);
      expect([style, routeServesEndpointStyle("cf_aig", "openai", style)]).toEqual([style, true]);
    }
    expect(routeServesEndpointStyle("vercel", "openai", "responses")).toBe(true);
    expect(routeServesEndpointStyle("vercel", "openai", "transcription")).toBe(false);
    // A provider type the gateway does not serve at all has no route to judge.
    expect(routeServesEndpointStyle("vercel", "groq", "responses")).toBe(false);
  });

  it("labels every provider type the shared list admits", () => {
    for (const provider of PROVIDER_TYPES) {
      expect([provider, typeof PROVIDER_LABELS[provider]]).toEqual([provider, "string"]);
      // And every one of them has a capability the console can describe.
      expect([provider, providerCapability(provider).apiStyles.length > 0])
        .toEqual([provider, true]);
    }
  });
});
