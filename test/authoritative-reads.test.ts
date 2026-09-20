import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountLifecycle } from "../src/core/account-lifecycle";
import { verifyApiKey } from "../src/core/apikeys";
import { loadAppConfig } from "../src/core/config";
import { organizationProviders } from "../src/core/provider-store";
import {
  clearIsolateCaches,
  seedProvider,
  seedServerApp,
  TEST_ORGANIZATION_ID,
} from "./helpers";

/** A primary binding whose replica-session path is forbidden. */
function primaryOnlyEnv(): { value: Env; sessionCalls: () => number } {
  let sessionCalls = 0;
  const binding = {
    prepare: (query: string) => env.DB.prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => env.DB.batch<T>(statements),
    exec: (query: string) => env.DB.exec(query),
    withSession: () => {
      sessionCalls += 1;
      throw new Error("security cache fill attempted an unconstrained D1 session");
    },
  } as unknown as D1Database;
  return {
    value: new Proxy(env, {
      get: (target, property, receiver) =>
        property === "DB" ? binding : Reflect.get(target, property, receiver),
    }) as Env,
    sessionCalls: () => sessionCalls,
  };
}

describe("authoritative security cache fills", () => {
  it("fills app, API-key, provider, and lifecycle caches from the primary binding", async () => {
    const appId = "primary-cache-fills";
    const key = await seedServerApp(appId);
    await seedProvider({
      type: "openai",
      id: "primary-cache-provider",
      slug: "primary-cache-provider",
    });
    clearIsolateCaches();
    const primary = primaryOnlyEnv();

    await expect(loadAppConfig(primary.value, appId)).resolves.toMatchObject({ id: appId });
    await expect(verifyApiKey(key, primary.value, appId, null)).resolves.toMatchObject({
      apiKeyId: `key_${appId}`,
    });
    await expect(organizationProviders(primary.value, TEST_ORGANIZATION_ID)).resolves.toHaveProperty(
      "primary-cache-provider",
    );
    await expect(accountLifecycle(primary.value, TEST_ORGANIZATION_ID)).resolves.toMatchObject({
      id: TEST_ORGANIZATION_ID,
    });
    expect(primary.sessionCalls()).toBe(0);
  });
});
