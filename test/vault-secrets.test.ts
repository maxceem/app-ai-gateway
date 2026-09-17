import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SecretVaultConfigurationError } from "../src/vault";
import {
  openSecret,
  sealSecret,
  secretContext,
  secretIdentityLength,
  SECRET_KINDS,
  type SecretKind,
} from "../src/vault/secrets";

/**
 * Stand-in ids, one per field the kind binds to.
 *
 * Built from the table's own arity rather than from a list repeated here, so a
 * kind added later is covered by these tests on the day it is added and not on
 * the day someone remembers to extend a fixture.
 */
function identity(kind: SecretKind, filler = "x"): string[] {
  return Array.from({ length: secretIdentityLength(kind) }, (_, index) => `${filler}-${index}`);
}

// The limits cf-kms enforces on an encryption context. Repeated here on
// purpose: a test that imported them from the code under test would pass just
// as happily if that code loosened them.
const MAX_ENTRIES = 8;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;

describe("secret contexts", () => {
  it("covers every kind the table declares", () => {
    expect(SECRET_KINDS.length).toBeGreaterThan(0);
  });

  it.each(SECRET_KINDS)("binds %s to a context cf-kms accepts", (kind) => {
    const context = secretContext(kind, identity(kind) as never);
    const entries = Object.entries(context);

    // The reason this file exists: the cf-kms caller is pinned to this value
    // through `requiredContext`, and a context without it is refused as
    // `unauthorized` — in kms mode only, which no test suite runs.
    expect(context.service).toBe("app-ai-gateway");

    expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
    for (const [key, value] of entries) {
      expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      expect(value.length).toBeLessThanOrEqual(MAX_VALUE_LENGTH);
    }
  });

  it.each(SECRET_KINDS)("distinguishes one %s from another", (kind) => {
    expect(secretContext(kind, identity(kind) as never)).not.toEqual(
      secretContext(kind, identity(kind, "other") as never),
    );
  });

  it("gives every kind a context of its own", () => {
    const rendered = SECRET_KINDS.map((kind) =>
      JSON.stringify(secretContext(kind, identity(kind) as never)),
    );
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("refuses an id too long for a context value", () => {
    const kind = SECRET_KINDS[0]!;
    const oversized = identity(kind).map(() => "z".repeat(MAX_VALUE_LENGTH + 1));
    expect(() => secretContext(kind, oversized as never)).toThrow(SecretVaultConfigurationError);
  });
});

describe("sealed secrets", () => {
  it.each(SECRET_KINDS)("opens a sealed %s under the same identity", async (kind) => {
    const ids = identity(kind) as never;
    const blob = await sealSecret(env, kind, ids, "secret-value");
    await expect(openSecret(env, kind, ids, blob)).resolves.toBe("secret-value");
  });

  it.each(SECRET_KINDS)("refuses to open a %s under another identity", async (kind) => {
    const blob = await sealSecret(env, kind, identity(kind) as never, "secret-value");
    await expect(
      openSecret(env, kind, identity(kind, "other") as never, blob),
    ).rejects.toThrow();
  });
});
