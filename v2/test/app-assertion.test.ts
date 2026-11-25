import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertionClientData, verifyAppAssertion } from "../src/client-auth/app-assertion.ts";
import { encodeCbor } from "./app-attest-fixtures.ts";

async function digest(value: Uint8Array): Promise<Buffer> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer));
}

async function assertionFixture(input: {
  gatewayAppId: string;
  rpId: string;
  challenge: string;
  keyId: string;
  counter: number;
}): Promise<{ assertion: string; publicKeyPem: string; clientDataHash: Buffer }> {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const authenticatorData = Buffer.alloc(37);
  (await digest(Buffer.from(input.rpId))).copy(authenticatorData, 0);
  authenticatorData[32] = 1;
  authenticatorData.writeUInt32BE(input.counter, 33);
  const clientDataHash = await digest(assertionClientData(input.gatewayAppId, input.challenge, input.keyId));
  const nonce = await digest(Buffer.concat([authenticatorData, clientDataHash]));
  const signer = createSign("SHA256");
  signer.update(nonce);
  const signature = signer.sign(pair.privateKey);
  return {
    assertion: Buffer.from(encodeCbor({ signature, authenticatorData })).toString("base64"),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    clientDataHash,
  };
}

describe("App Attest assertions", () => {
  it("uses the exact canonical clientData bytes produced by the Swift client", () => {
    const bytes = assertionClientData("dev-app", "challenge", "key");
    expect(bytes).toEqual(
      new TextEncoder().encode('{"app":"dev-app","challenge":"challenge","key_id":"key"}'),
    );
  });

  it("verifies the signature and RP ID, and answers the counter for the install to judge", async () => {
    const input = {
      gatewayAppId: "dev-app",
      rpId: "AAAAAAAAAA.com.example.app",
      challenge: Buffer.from("one-time-challenge").toString("base64"),
      keyId: Buffer.alloc(32, 7).toString("base64"),
      counter: 7,
    };
    const fixture = await assertionFixture(input);
    await expect(verifyAppAssertion({ rpId: input.rpId, ...fixture })).resolves.toBe(7);
    // The same assertion in URL-safe base64, as a request proof carries it.
    const urlSafe = fixture.assertion.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    await expect(verifyAppAssertion({ rpId: input.rpId, ...fixture, assertion: urlSafe })).resolves.toBe(7);
    // Signed over other client data, or for another app, it is refused.
    await expect(verifyAppAssertion({ rpId: input.rpId, ...fixture, clientDataHash: await digest(Buffer.from("other")) }))
      .rejects.toMatchObject({ code: "attest_failed" });
    await expect(verifyAppAssertion({ ...fixture, rpId: "AAAAAAAAAA.com.example.other" }))
      .rejects.toMatchObject({ code: "attest_failed" });
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
        rpId: input.rpId,
        assertion: fixture.assertion,
        clientDataHash: fixture.clientDataHash,
        publicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }),
    ).rejects.toMatchObject({ code: "attest_failed" });
  });

  it("refuses a malformed assertion with attest_failed, never a server error", async () => {
    const input = {
      gatewayAppId: "dev-app",
      rpId: "AAAAAAAAAA.com.example.app",
      challenge: Buffer.from("one-time-challenge").toString("base64"),
      keyId: Buffer.alloc(32, 9).toString("base64"),
      counter: 3,
    };
    const fixture = await assertionFixture(input);
    const bytes = Buffer.from(fixture.assertion, "base64");
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signature = createSign("SHA256").update("x").sign(pair.privateKey);
    const malformed = [
      bytes.subarray(0, bytes.byteLength - 1),
      Buffer.concat([bytes, Buffer.from([0x40])]),
      encodeCbor({ signature, authenticatorData: Buffer.alloc(36) }),
      encodeCbor({ authenticatorData: Buffer.alloc(37) }),
    ];
    for (const assertion of malformed) {
      await expect(verifyAppAssertion({
        rpId: input.rpId,
        assertion: Buffer.from(assertion).toString("base64"),
        publicKeyPem: fixture.publicKeyPem,
        clientDataHash: fixture.clientDataHash,
      })).rejects.toMatchObject({ status: 403, code: "attest_failed" });
    }
  });
});
