import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync } from "node:crypto";
import { encode } from "cbor-x";
import { describe, expect, it } from "vitest";
import { assertionClientData, verifyAppAssertion } from "../src/core/appattest";

async function digest(value: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
}

async function assertionFixture(input: {
  gatewayAppId: string;
  rpId: string;
  challenge: string;
  keyId: string;
  counter: number;
}): Promise<{ assertion: string; publicKeyPem: string }> {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const authenticatorData = Buffer.alloc(37);
  (await digest(Buffer.from(input.rpId))).copy(authenticatorData, 0);
  authenticatorData[32] = 1;
  authenticatorData.writeUInt32BE(input.counter, 33);
  const clientHash = await digest(assertionClientData(input.gatewayAppId, input.challenge, input.keyId));
  const nonce = await digest(Buffer.concat([authenticatorData, clientHash]));
  const signer = createSign("SHA256");
  signer.update(nonce);
  const signature = signer.sign(pair.privateKey);
  return {
    assertion: Buffer.from(encode({ signature, authenticatorData })).toString("base64"),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("App Attest assertions", () => {
  it("uses the exact canonical clientData bytes produced by the Swift client", () => {
    const bytes = assertionClientData("dev-app", "challenge", "key");
    expect(bytes).toEqual(
      new TextEncoder().encode('{"app":"dev-app","challenge":"challenge","key_id":"key"}'),
    );
  });

  it("verifies the signature, RP ID, and monotonic counter", async () => {
    const input = {
      gatewayAppId: "dev-app",
      rpId: "AAAAAAAAAA.com.example.app",
      challenge: Buffer.from("one-time-challenge").toString("base64"),
      keyId: Buffer.alloc(32, 7).toString("base64"),
      counter: 1,
    };
    const fixture = await assertionFixture(input);
    await expect(
      verifyAppAssertion({ ...input, ...fixture, previousCounter: 0 }),
    ).resolves.toBe(1);
    await expect(
      verifyAppAssertion({ ...input, ...fixture, previousCounter: 1 }),
    ).rejects.toMatchObject({ code: "attest_failed" });
  });

  it("rejects an assertion verified against a different key", async () => {
    const input = {
      gatewayAppId: "dev-app",
      rpId: "AAAAAAAAAA.com.example.app",
      challenge: Buffer.from("one-time-challenge").toString("base64"),
      keyId: Buffer.alloc(32, 8).toString("base64"),
      counter: 2,
    };
    const fixture = await assertionFixture(input);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    await expect(
      verifyAppAssertion({
        ...input,
        assertion: fixture.assertion,
        publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
        previousCounter: 0,
      }),
    ).rejects.toMatchObject({ code: "attest_failed" });
  });
});
