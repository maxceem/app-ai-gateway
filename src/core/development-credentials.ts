import { and, eq } from "drizzle-orm";
import { database } from "../db";
import { developmentCredentials } from "../db/schema";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const encoder = new TextEncoder();

function randomString(length: number): string {
  const limit = 256 - (256 % BASE62.length);
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(32, length - result.length)));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      result += BASE62[byte % BASE62.length]!;
      if (result.length === length) break;
    }
  }
  return result;
}

export async function hashDevelopmentSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generateDevelopmentCredential(): Promise<{
  secret: string;
  secretHash: string;
  secretPrefix: string;
}> {
  const secret = `dev_${randomString(48)}`;
  return {
    secret,
    secretHash: await hashDevelopmentSecret(secret),
    secretPrefix: secret.slice(0, 12),
  };
}

export async function verifyDevelopmentCredential(
  env: Env,
  appId: string,
  secret: string,
): Promise<boolean> {
  const secretHash = await hashDevelopmentSecret(secret);
  const row = await database(env.DB).query.developmentCredentials.findFirst({
    columns: { appId: true },
    where: and(
      eq(developmentCredentials.appId, appId),
      eq(developmentCredentials.secretHash, secretHash),
    ),
  });
  return row !== undefined;
}
