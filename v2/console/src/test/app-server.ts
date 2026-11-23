import { vi } from "vitest";

const APP_URL = "/v2/admin/apps/my-app";

type Operation = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

const unescape = (segment: string) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~");

/** Applies JSON Patch operations to a copy of `document`, as the gateway does (RFC 6902, add, replace and remove). */
export function applyPatch<T>(document: T, operations: Operation[]): T {
  const result = structuredClone(document) as Record<string, unknown>;
  for (const operation of operations) {
    const parts = operation.path.split("/").slice(1).map(unescape);
    const last = parts.pop()!;
    let target: Record<string, unknown> = result;
    for (const part of parts) {
      const next = target[part];
      if (typeof next !== "object" || next === null) throw new Error(`${operation.path}: its parent does not exist`);
      target = next as Record<string, unknown>;
    }
    if (operation.op === "remove") {
      if (!Object.hasOwn(target, last)) throw new Error(`${operation.path}: nothing to remove`);
      delete target[last];
    } else {
      if (operation.op === "replace" && !Object.hasOwn(target, last)) throw new Error(`${operation.path}: nothing to replace`);
      target[last] = operation.value;
    }
  }
  return result as T;
}

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
      state.app = { ...applyPatch(state.app, body.operations), revision: (state.app.revision as number) + 1 };
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
