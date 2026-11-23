import { vi } from "vitest";
// The gateway's own JSON Patch, so a test starts only from states the gateway can produce.
import { applyAppPatch } from "../../../src/admin/app-patch.ts";

const APP_URL = "/v2/admin/apps/my-app";

type Operation = Parameters<typeof applyAppPatch>[1][number];

/**
 * A small stand-in for the gateway's app routes: reads answer the stored app,
 * a PATCH at the stored revision applies its operations and bumps the
 * revision, and a PATCH at another revision is refused with 409, as the
 * gateway does. `refuse` answers the next PATCH with an error instead.
 */
export function appServer(app: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const state = { app: structuredClone(app), refuse: null as null | { status: number; code: string; message: string } };
  const patches: { revision: number; operations: Operation[] }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === APP_URL && method === "PATCH") {
      const body = JSON.parse(String(init!.body)) as { revision: number; operations: Operation[] };
      patches.push(body);
      if (state.refuse) {
        const { status, code, message } = state.refuse;
        state.refuse = null;
        return reply({ error: { code, message } }, status);
      }
      if (body.revision !== state.app.revision) return reply({ error: { code: "app_revision_conflict", message: "The app changed since it was read" } }, 409);
      const { name, status, config } = state.app as { name: unknown; status: unknown; config: unknown };
      let patched: Record<string, unknown>;
      try {
        patched = applyAppPatch({ name, status, config }, body.operations);
      } catch (error) {
        return reply({ error: { code: "invalid_request", message: error instanceof Error ? error.message : "invalid" } }, 400);
      }
      state.app = { ...state.app, ...patched, revision: (state.app.revision as number) + 1 };
      return reply({ app: state.app });
    }
    const found = Object.entries(extra).find(([prefix]) => url.startsWith(prefix));
    if (found) return reply(found[1]);
    return reply({ app: state.app });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    state,
    patches,
    fetchMock,
    /** Someone else saves the app: the stored app becomes this, one revision on. */
    changeElsewhere(change: (app: Record<string, unknown>) => Record<string, unknown>) {
      state.app = { ...change(structuredClone(state.app)), revision: (state.app.revision as number) + 1 };
    },
  };
}
