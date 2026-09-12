import { describe, expect, it } from "vitest";
import {
  ENTITLEMENT_PRESETS,
  ISSUER_PRESETS,
  buildEntitlement,
  buildIssuer,
  REVENUECAT_CLAIM_PATH,
  matchIssuerPreset,
  mergeClaims,
  revenueCatClaim,
  revenueCatEntitlement,
} from "./presets";

describe("issuer presets", () => {
  // Builders run on the first render of the create dialog, before any field has
  // been touched. Reading a missing input used to throw and take the dialog down.
  it("build without throwing when no input has been filled in", () => {
    for (const preset of ISSUER_PRESETS) {
      expect(() => buildIssuer(preset, {}), preset.id).not.toThrow();
      const fragment = buildIssuer(preset, {});
      expect(typeof fragment.jwks_url, preset.id).toBe("string");
      expect(typeof fragment.issuer, preset.id).toBe("string");
      expect(typeof fragment.audience, preset.id).toBe("string");
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
    expect(fragment.issuer).toBe("https://my-tenant.us.auth0.com/");
    expect(fragment.audience).toBe("https://api.my-app.com");
  });

  it("scopes Firebase to one project, since its key set is shared by every project", () => {
    const firebase = ISSUER_PRESETS.find((preset) => preset.id === "firebase")!;
    const fragment = buildIssuer(firebase, { project_id: "my-app-1a2b3" });
    expect(fragment.jwks_url).toBe(
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    );
    // The shared Google key set signs every project, so these two fields are
    // the only thing that keeps another project's tokens out.
    expect(fragment.issuer).toBe("https://securetoken.google.com/my-app-1a2b3");
    expect(fragment.audience).toBe("my-app-1a2b3");
    expect(fragment.required_claims).toEqual([]);
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

describe("matchIssuerPreset", () => {
  const stored = (preset: string, values: Record<string, string>) => {
    const fragment = buildIssuer(ISSUER_PRESETS.find((entry) => entry.id === preset)!, values);
    return { jwks_url: fragment.jwks_url, issuer: fragment.issuer, audience: fragment.audience };
  };

  it("recovers the preset and inputs every vendor preset wrote", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["firebase", { project_id: "my-app-1a2b3" }],
      ["supabase", { project_ref: "abcdefghijklmnop" }],
      ["auth0", { domain: "my-tenant.us.auth0.com", audience: "https://api.my-app.com" }],
      ["clerk", { frontend_api: "clean-mayfly-62.clerk.accounts.dev", audience: "my-app" }],
    ];
    for (const [id, values] of cases) {
      const found = matchIssuerPreset(stored(id, values));
      expect(found.preset.id, id).toBe(id);
      expect(found.values, id).toEqual(values);
    }
  });

  it("trusts the provider the block names, even before its inputs are complete", () => {
    // Half-typed on the Auth policy page: the form must reopen on Auth0 with
    // the audience kept, not guess custom because the domain is still empty.
    const found = matchIssuerPreset({
      provider: "auth0",
      jwks_url: "https:///.well-known/jwks.json",
      issuer: "https:///",
      audience: "https://api.my-app.com",
    });
    expect(found.preset.id).toBe("auth0");
    expect(found.values).toEqual({ domain: "", audience: "https://api.my-app.com" });
  });

  it("falls back to custom for an issuer no preset could have written", () => {
    const found = matchIssuerPreset({
      jwks_url: "https://issuer.example.test/keys.json",
      issuer: "https://issuer.example.test",
      audience: "my-api",
    });
    expect(found.preset.id).toBe("custom");
    // The custom form opens on what is stored, so nothing is lost by the fallback.
    expect(found.values).toEqual({
      jwks_url: "https://issuer.example.test/keys.json",
      issuer: "https://issuer.example.test",
      audience: "my-api",
    });
  });

  it("treats a hand-edited vendor issuer as custom rather than misnaming it", () => {
    // Firebase's iss with a JWKS URL Firebase does not publish.
    const found = matchIssuerPreset({
      jwks_url: "https://issuer.example.test/keys.json",
      issuer: "https://securetoken.google.com/my-app",
      audience: "my-app",
    });
    expect(found.preset.id).toBe("custom");
  });

  it("reads a stored one-value list as the single value the Worker normalized", () => {
    // The Worker stores iss and aud as lists even when one value was written.
    const found = matchIssuerPreset({
      jwks_url:
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      issuer: ["https://securetoken.google.com/my-app-1a2b3"],
      audience: ["my-app-1a2b3"],
    });
    expect(found.preset.id).toBe("firebase");
    expect(found.values).toEqual({ project_id: "my-app-1a2b3" });
  });

  it("treats an issuer accepting several tenants as custom", () => {
    const found = matchIssuerPreset({
      jwks_url:
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      issuer: ["https://securetoken.google.com/a", "https://securetoken.google.com/b"],
      audience: ["a", "b"],
    });
    expect(found.preset.id).toBe("custom");
  });
});

describe("the RevenueCat entitlement check", () => {
  const revenuecat = ENTITLEMENT_PRESETS.find((preset) => preset.id === "revenuecat")!;

  // The claim RevenueCat's own Firebase extension writes. Getting this wrong
  // rejects every paying user, and does it silently: the token verifies, the
  // claim is simply not where the gateway looked.
  it("writes the claim RevenueCat itself writes, asking only for the entitlement", () => {
    expect(revenuecat.inputs.map((input) => input.key)).toEqual(["entitlement"]);
    expect(buildEntitlement(revenuecat, { entitlement: " pro " })).toEqual([
      { path: "revenueCatEntitlements", contains: "pro" },
    ]);
    expect(REVENUECAT_CLAIM_PATH).toBe("revenueCatEntitlements");
  });

  it("takes several ids as alternatives, any one of which admits the user", () => {
    expect(buildEntitlement(revenuecat, { entitlement: "pro, pro_test" })).toEqual([
      { path: REVENUECAT_CLAIM_PATH, contains: ["pro", "pro_test"] },
    ]);
  });

  it("reads its entitlement back, so the same one field reopens on what was saved", () => {
    expect(revenueCatEntitlement([revenueCatClaim("pro")])).toBe("pro");
    expect(revenueCatEntitlement([revenueCatClaim("pro, pro_test")])).toBe("pro, pro_test");
    // A check started but not filled in is still a RevenueCat check.
    expect(revenueCatEntitlement([revenueCatClaim("")])).toBe("");
  });

  // The field is bound to the claim this writes, so normalizing a lone id would
  // swallow the comma as it is typed and no list could ever be entered.
  it("keeps a half-typed list intact between keystrokes", () => {
    expect(revenueCatEntitlement([revenueCatClaim("pro,")])).toBe("pro, ");
  });

  it("declines only the shapes its one field could not hold", () => {
    // Opening the one-field form on either of these would quietly drop whatever
    // makes them different, so the full editor keeps them.
    expect(revenueCatEntitlement([{ path: REVENUECAT_CLAIM_PATH, equals: "pro" }])).toBeNull();
    expect(revenueCatEntitlement([revenueCatClaim("pro"), { path: "scope", contains: "ai" }]))
      .toBeNull();
  });

  // The preset owns the path, so a check written against the older default is
  // still a RevenueCat check; demoting it to a custom claim would lose the
  // answer over a field the operator never chose.
  it("reopens a check written against an older claim path", () => {
    expect(revenueCatEntitlement([{ path: "entitlements", contains: "pro" }])).toBe("pro");
    // A paid check with nothing filled in yet is one waiting for its id.
    expect(revenueCatEntitlement([])).toBe("");
  });
});
