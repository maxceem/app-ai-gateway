/**
 * A provider key while the vault cannot be reached: the last copy opened from
 * the same sealed blob serves for up to an hour past its expiry, logged as
 * `provider_secret_stale`, as v1 (`provider-store.test.ts` at the repository
 * root). A fault in the deployment's own vault setup never does.
 *
 * The local vault reports every decrypt failure as a blob fault, so only a
 * KMS vault meets a transport failure. The open step is given to `opened`
 * here, so each kind of failure can be made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opened, type ConnectionRecord } from "../src/providers/connections.ts";
import { SecretVaultConfigurationError } from "../src/vault/types.ts";
import { clearCaches } from "./helpers.ts";

const SECRET = "sk-test-stale-provider-key-5678";
const TEN_MINUTES = 10 * 60_000;
const HOUR = 60 * 60_000;

function connection(): ConnectionRecord {
  return {
    id: `conn_${crypto.randomUUID().slice(0, 8)}`,
    accountId: "acc_stale",
    type: "openai",
    slug: "openai",
    status: "active",
    baseUrl: null,
    secretBlob: `cfkms-env1.${crypto.randomUUID()}`,
    rates: null,
    cloudflareGateway: null,
    servingProviders: null,
  };
}

const unreachable = () => Promise.reject(new Error("the vault could not be reached"));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearCaches();
  vi.useFakeTimers({ toFake: ["Date"] });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a provider key while the vault cannot be reached", () => {
  it("serves the last opened copy for up to an hour past its expiry, logged without the key, never refreshed", async () => {
    const record = connection();
    const blob = record.secretBlob!;
    expect(await opened(record, "providerKey", () => Promise.resolve(SECRET), blob)).toBe(SECRET);

    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const failing = vi.fn(unreachable);
    expect(await opened(record, "providerKey", failing, blob)).toBe(SECRET);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("provider_secret_stale");
    expect(logged).not.toContain(SECRET);
    // Not refreshed: every request goes back to the vault first.
    vi.setSystemTime(Date.now() + HOUR - 2);
    expect(await opened(record, "providerKey", failing, blob)).toBe(SECRET);
    expect(failing).toHaveBeenCalledTimes(2);

    // An hour past the copy's expiry, it no longer serves.
    vi.setSystemTime(Date.now() + 1);
    await expect(opened(record, "providerKey", failing, blob)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  it("never serves a stale copy through a fault in the deployment's own vault setup", async () => {
    const record = connection();
    const blob = record.secretBlob!;
    await opened(record, "providerKey", () => Promise.resolve(SECRET), blob);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    const misconfigured = () => Promise.reject(new SecretVaultConfigurationError("the vault's key is missing", { setting: "SECRET_VAULT_MODE", problem: "missing" } as never));
    await expect(opened(record, "providerKey", misconfigured, blob)).rejects.toMatchObject({ status: 502, code: "provider_unavailable" });
  });

  it("never serves a copy opened from another blob: a rotated key is not brought back", async () => {
    const record = connection();
    await opened(record, "providerKey", () => Promise.resolve(SECRET), record.secretBlob!);
    vi.setSystemTime(Date.now() + TEN_MINUTES + 1);
    await expect(opened(record, "providerKey", unreachable, `cfkms-env1.${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 502 });
  });
});
