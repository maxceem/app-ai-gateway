import { describe, expect, it } from "vitest";
import {
  ENTITLEMENT_PRESETS,
  ISSUER_PRESETS,
  buildEntitlement,
  buildIssuer,
  mergeClaims,
} from "./presets";

describe("issuer presets", () => {
  // Builders run on the first render of the create dialog, before any field has
  // been touched. Reading a missing input used to throw and take the dialog down.
  it("build without throwing when no input has been filled in", () => {
    for (const preset of ISSUER_PRESETS) {
      expect(() => buildIssuer(preset, {}), preset.id).not.toThrow();
      const fragment = buildIssuer(preset, {});
      expect(typeof fragment.jwks_url, preset.id).toBe("string");
      expect(fragment.user_id_claim, preset.id).toBe("sub");
    }
    for (const preset of ENTITLEMENT_PRESETS) {
      expect(() => buildEntitlement(preset, {}), preset.id).not.toThrow();
      expect(buildEntitlement(preset, {}), preset.id).toEqual([]);
    }
  });

  it("trims input and tolerates a pasted URL where a host is expected", () => {
    const auth0 = ISSUER_PRESETS.find((preset) => preset.id === "auth0")!;
    const fragment = buildIssuer(auth0, {
      domain: "  https://my-tenant.us.auth0.com/  ",
      audience: " https://api.my-app.com ",
    });
    expect(fragment.jwks_url).toBe("https://my-tenant.us.auth0.com/.well-known/jwks.json");
    // Auth0 puts a trailing slash in iss; dropping it rejects every token.
    expect(fragment.required_claims).toContainEqual({
      path: "iss",
      equals: "https://my-tenant.us.auth0.com/",
    });
    expect(fragment.required_claims).toContainEqual({
      path: "aud",
      contains: "https://api.my-app.com",
    });
  });

  it("scopes Firebase to one project, since its key set is shared by every project", () => {
    const firebase = ISSUER_PRESETS.find((preset) => preset.id === "firebase")!;
    const fragment = buildIssuer(firebase, { project_id: "my-app-1a2b3" });
    expect(fragment.jwks_url).toBe(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    );
    expect(fragment.required_claims).toEqual([
      { path: "aud", equals: "my-app-1a2b3" },
      { path: "iss", equals: "https://securetoken.google.com/my-app-1a2b3" },
    ]);
  });

  it("normalizes a Supabase project ref given as a full host", () => {
    const supabase = ISSUER_PRESETS.find((preset) => preset.id === "supabase")!;
    expect(buildIssuer(supabase, { project_ref: "https://abcdef.supabase.co" }).jwks_url).toBe(
      "https://abcdef.supabase.co/auth/v1/.well-known/jwks.json",
    );
  });
});

describe("mergeClaims", () => {
  it("replaces by path, keeps unrelated requirements, and stays idempotent", () => {
    const existing = [
      { path: "aud", equals: "old-project" },
      { path: "scope", contains: "ai.invoke" },
    ];
    const incoming = [{ path: "aud", equals: "new-project" }];
    const merged = mergeClaims(existing, incoming);
    expect(merged).toEqual([
      { path: "scope", contains: "ai.invoke" },
      { path: "aud", equals: "new-project" },
    ]);
    expect(mergeClaims(merged, incoming)).toEqual(merged);
  });
});
