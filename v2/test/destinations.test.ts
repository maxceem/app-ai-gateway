/**
 * Where a provider key can go (`src/providers/destinations.ts`): the console's
 * key fields name these, so they must be every origin the gateway's routing
 * can send the key to, and no other.
 */
import { describe, expect, it } from "vitest";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { upstreamOrigin, type ConnectionRecord } from "../src/providers/connections.ts";
import { cloudflareGatewayOrigin, cloudflareGatewayPath, cloudflareIdProblem, destinationText, keyDestinations } from "../src/providers/destinations.ts";

const record = (type: string, baseUrl: string | null) => ({ type, baseUrl, cloudflareGateway: null }) as unknown as ConnectionRecord;

/** Every origin the routing itself produces for a connection, over all hosts and passthrough. */
function routed(type: string, baseUrl: string | null): string[] {
  const description = BUILT_IN_PROVIDERS[type]!;
  return [...new Set(Object.keys(description.hosts).flatMap((hostKey) => [false, true].map((passthrough) => upstreamOrigin(record(type, baseUrl), description, hostKey, passthrough))))];
}

describe("key destinations", () => {
  it("are every origin the routing sends to, for every built-in provider, with and without a base URL", () => {
    for (const [type, description] of Object.entries(BUILT_IN_PROVIDERS)) {
      for (const baseUrl of [null, "https://self-hosted.example.com/v1/", `https://${description.hosts.main}/`]) {
        expect(keyDestinations(description, { baseUrl, cloudflareGateway: null }).sort()).toEqual(routed(type, baseUrl).sort());
      }
    }
  });

  it("name both of fal's hosts", () => {
    expect(destinationText(keyDestinations(BUILT_IN_PROVIDERS.fal!, { baseUrl: null, cloudflareGateway: null }))).toBe("fal.run, queue.fal.run");
  });

  it("are the Cloudflare gateway alone when traffic goes through it, and a custom provider's base URL", () => {
    const gateway = { accountId: "acct", gatewayId: "gw" };
    expect(keyDestinations(BUILT_IN_PROVIDERS.openai!, { baseUrl: null, cloudflareGateway: gateway })).toEqual([cloudflareGatewayOrigin(gateway)]);
    expect(keyDestinations(null, { baseUrl: "https://llm.example.com/v1/", cloudflareGateway: null })).toEqual(["https://llm.example.com/v1/"]);
  });

  it("take as a Cloudflare id only one plain path segment, so the address cannot move once parsed", () => {
    for (const id of ["0123456789abcdef0123456789abcdef", "my-gateway", "gw_1.prod~2"]) expect(cloudflareIdProblem(id), id).toBeNull();
    expect(cloudflareIdProblem(".")).toBe("cannot be . or ..");
    expect(cloudflareIdProblem("..")).toBe("cannot be . or ..");
    for (const id of ["a/b", "%2e%2e", "%2F", "acct 1", "gw?x", "gw#x", "acct\uD800", "ü"]) expect(cloudflareIdProblem(id), id).not.toBeNull();
  });

  it("lead nowhere for ids a URL parser would read as a folder, and keep every other stored id inside its segment", () => {
    for (const gatewayId of [".", ".."]) {
      expect(cloudflareGatewayPath({ accountId: "acct", gatewayId })).toBeNull();
      expect(keyDestinations(BUILT_IN_PROVIDERS.openai!, { baseUrl: null, cloudflareGateway: { accountId: "acct", gatewayId } })).toEqual([]);
    }
    expect(keyDestinations(BUILT_IN_PROVIDERS.openai!, { baseUrl: null, cloudflareGateway: { accountId: "acct\uDC00", gatewayId: "gw" } })).toEqual([]);
    // Stored before the rule: encoded, so it stays one segment, and the address parses back to itself.
    const path = cloudflareGatewayPath({ accountId: "acct 1", gatewayId: "a/../b" })!;
    expect(path).toBe("v1/acct%201/a%2F..%2Fb/");
    expect(new URL(path, "https://gateway.ai.cloudflare.com/").pathname).toBe(`/${path}`);
  });
});
