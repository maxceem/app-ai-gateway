import type { CliTool } from "../src/catalog.ts";
import type { ContextStore } from "../src/context.ts";
import { emptyState, type CliState, type KeyOutput } from "../src/state.ts";
import type { FormResponse, RequestOptions, WireResponse } from "../src/transport.ts";

export const fresh = (): CliState => emptyState();

/** A state signed in to `url` with a token that does not expire during a test. */
export function signedInState(url: string, accessToken: string, expiresAt = "2999-01-01T00:00:00.000Z"): CliState {
  return {
    schemaVersion: 1,
    active: {
      url,
      login: { id: "login_1", clientId: "agw-cli", accessToken, refreshToken: "agw_ort_test", expiresAt, grant: "manage" },
      account: { id: "org_1", name: "Acme" },
    },
  };
}

/**
 * A store held in memory: `update` runs the change on a copy of what it holds,
 * as the real one runs it on what is on disk.
 */
export function memoryStore(initial: CliState = fresh()) {
  let held: CliState = structuredClone(initial);
  const store = {
    writes: 0,
    get held(): CliState {
      return held;
    },
    set held(next: CliState) {
      held = structuredClone(next);
    },
    read: async () => structuredClone(held),
    update: async <T>(change: (state: CliState) => Promise<T> | T) => {
      const state = structuredClone(held);
      const result = await change(state);
      held = structuredClone(state);
      store.writes++;
      return { state: structuredClone(state), result };
    },
    keyOutput: async (_path?: string): Promise<KeyOutput> => {
      throw new Error("keyOutput is not stubbed in this test");
    },
    /** Hand-off links "written", by operation id; nothing reaches a disk. */
    handoffs: new Map<string, string>(),
    handoffFile: async (id: string, url: string): Promise<string> => {
      store.handoffs.set(id, url);
      return `/private/handoffs/${id}.url`;
    },
  };
  return store;
}

export const makeStore = (): ContextStore & { read: () => Promise<CliState> } => memoryStore();

/** The `code` a rejected CLI promise carries, for `assert.rejects` predicates. */
export function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

/** A tool as `GET /v2/cli/tools` lists it, with the parts a test does not care about filled in. */
export function cliTool(
  name: string,
  cli: CliTool["cli"],
  input: { properties?: Record<string, unknown>; required?: string[] } = {},
  annotations: Partial<CliTool["annotations"]> = {},
): CliTool {
  return {
    name,
    title: name.replaceAll("_", " "),
    description: `Runs ${name}.`,
    inputSchema: { type: "object", properties: input.properties ?? {}, ...(input.required ? { required: input.required } : {}) },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, ...annotations },
    cli,
  };
}

export type Handler = (path: string, options: RequestOptions) => WireResponse | Promise<WireResponse>;
export type FormHandler = (path: string, fields: Record<string, string>) => FormResponse | Promise<FormResponse>;

/** A transport whose JSON requests and OAuth form posts are answered by the handlers given. */
export function fakeTransport(json: Handler, form: FormHandler = () => ({ status: 500, data: {} })) {
  const calls: { kind: "json" | "form"; path: string; method?: string; key?: string; body?: unknown; fields?: Record<string, string> }[] = [];
  return {
    calls,
    request: async (_url: string, path: string, options: RequestOptions = {}) => {
      calls.push({
        kind: "json",
        path,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
      return json(path, options);
    },
    postForm: async (_url: string, path: string, fields: Record<string, string>) => {
      calls.push({ kind: "form", path, fields });
      return form(path, fields);
    },
  };
}

/** A clock that only moves when a test sleeps on it. */
export function fakeClock(start = Date.parse("2026-11-20T10:00:00.000Z")) {
  const clock = {
    time: start,
    slept: [] as number[],
    now: () => clock.time,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      clock.time += ms;
    },
  };
  return clock;
}

/** Output sinks that keep what they were given. */
export function sinks() {
  const out = { text: "" };
  const err = { text: "" };
  return {
    out,
    err,
    stdout: { write: (text: string) => void (out.text += text) },
    stderr: { write: (text: string) => void (err.text += text) },
  };
}
