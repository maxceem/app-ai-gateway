/**
 * The relay Worker's entry (plan step 9a): the echo is off unless a test
 * deployment sets `RELAY_ECHO`, and that is checked before any session object
 * is created.
 */
import { describe, expect, it } from "vitest";
import relay, { ECHO_PATH, HEALTH_PATH } from "../relay/src/index.js";

/** A session namespace that records whether anything reached it. */
function sessions(answer = new Response("from the session", { status: 200 })) {
  const used: string[] = [];
  const namespace = {
    newUniqueId: () => {
      used.push("newUniqueId");
      return "id";
    },
    get: () => {
      used.push("get");
      return { fetch: async () => answer };
    },
  };
  return { used, namespace: namespace as unknown as DurableObjectNamespace };
}

const env = (namespace: DurableObjectNamespace, echo?: string) =>
  ({ SESSION: namespace, MAIN: {} as Fetcher, ...(echo === undefined ? {} : { RELAY_ECHO: echo }) }) as Parameters<typeof relay.fetch>[1];
const upgrade = { headers: { upgrade: "websocket" } };

describe("the relay's entry", () => {
  it("answers its health check", async () => {
    const response = await relay.fetch(new Request(`https://relay.example${HEALTH_PATH}`), env(sessions().namespace));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "app-ai-gateway-relay" });
  });

  it("refuses the echo, as a 404, without creating a session object, unless RELAY_ECHO is 1", async () => {
    for (const echo of [undefined, "", "0", "true"]) {
      const { used, namespace } = sessions();
      const response = await relay.fetch(new Request(`https://relay.example${ECHO_PATH}`, upgrade), env(namespace, echo));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found" } });
      expect(used).toEqual([]);
    }
  });

  it("with RELAY_ECHO 1, asks for a WebSocket before creating anything, then hands it to a new session object", async () => {
    const plain = sessions();
    const refused = await relay.fetch(new Request(`https://relay.example${ECHO_PATH}`), env(plain.namespace, "1"));
    expect(refused.status).toBe(426);
    expect(plain.used).toEqual([]);
    const live = sessions();
    const handed = await relay.fetch(new Request(`https://relay.example${ECHO_PATH}`, upgrade), env(live.namespace, "1"));
    expect(await handed.text()).toBe("from the session");
    expect(live.used).toEqual(["newUniqueId", "get"]);
  });
});
