import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppPatchOperation } from "../src/contracts/schemas";
import { applyAppPatch } from "../src/management/app-patch";
import { seedServerApp } from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };

async function read(appId: string) {
  const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}`, { headers: AUTH });
  return ((await response.json()) as { app: Record<string, any> }).app;
}

async function patch(appId: string, body: unknown) {
  const response = await exports.default.fetch(`${ORIGIN}/v1/admin/apps/${appId}`, {
    method: "PATCH",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("PATCH /v1/admin/apps/{app}", () => {
  it("changes only the settings it names, writing null as null", async () => {
    const appId = "patch-limits";
    await seedServerApp(appId);
    const before = await read(appId);
    const changed = await patch(appId, {
      revision: before.revision,
      operations: [
        { op: "replace", path: "/config/limits/per_app/requests/per_minute", value: 600 },
        { op: "replace", path: "/config/limits/per_app/spending/monthly_usd", value: null },
        { op: "add", path: "/config/routing/model_rewrites/fast", value: "gpt-5.6-terra" },
        { op: "replace", path: "/name", value: "Patched" },
      ],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const after = await read(appId);
    const expected = structuredClone(before.config);
    expected.limits.per_app.requests.per_minute = 600;
    expected.limits.per_app.spending.monthly_usd = null;
    expected.routing.model_rewrites.fast = "gpt-5.6-terra";
    expect(after.config).toEqual(expected);
    expect(after.name).toBe("Patched");
    expect(after.status).toBe(before.status);
    expect(after.revision).toBe(before.revision + 1);
    expect(changed.body.app).toEqual(after);
  });

  it("removes a key and edits a list in place", async () => {
    const appId = "patch-lists";
    await seedServerApp(appId, { proxy: { openai: { allowed_paths: ["v1/responses"], allowed_models: [] } } });
    const before = await read(appId);
    const first = await patch(appId, {
      revision: before.revision,
      operations: [
        { op: "add", path: "/config/routing/providers/selected/openai/allowed_paths/-", value: "v1/chat/completions" },
        { op: "add", path: "/config/routing/model_rewrites/old", value: "gpt-5.6-terra" },
      ],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.app.config.routing.providers.selected.openai.allowed_paths).toEqual(["v1/responses", "v1/chat/completions"]);
    const second = await patch(appId, {
      revision: first.body.app.revision,
      operations: [
        { op: "remove", path: "/config/routing/providers/selected/openai/allowed_paths/0" },
        { op: "remove", path: "/config/routing/model_rewrites/old" },
      ],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.app.config.routing.providers.selected.openai.allowed_paths).toEqual(["v1/chat/completions"]);
    expect(second.body.app.config.routing.model_rewrites).toEqual(before.config.routing.model_rewrites);
  });

  it("requires the revision it was read at, as PUT does", async () => {
    const appId = "patch-revision";
    await seedServerApp(appId);
    const operations = [{ op: "replace", path: "/name", value: "Renamed" }];
    const blind = await patch(appId, { operations });
    expect(blind.status).toBe(400);
    expect(blind.body.error.code).toBe("app_revision_required");
    expect((await patch(appId, { revision: 1, operations })).status).toBe(200);
    const stale = await patch(appId, { revision: 1, operations });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("app_revision_conflict");
  });

  it("writes nothing when an operation cannot apply or the result is refused", async () => {
    const appId = "patch-refused";
    await seedServerApp(appId);
    const before = await read(appId);
    const refusals: [unknown[], RegExp][] = [
      // The first applies, the second does not: nothing of either is saved.
      [[
        { op: "replace", path: "/name", value: "Half" },
        { op: "replace", path: "/config/limits/per_app/requests/per_hour", value: 5 },
      ], /^operations\[1\] \(replace \/config\/limits\/per_app\/requests\/per_hour\): nothing is there$/u],
      [[{ op: "add", path: "/config/nowhere/at_all", value: 1 }], /^operations\[0\] .*: its parent does not exist$/u],
      [[{ op: "add", path: "/config/routing/model_rewrites/a~1b/x", value: 1 }], /its parent does not exist/u],
      [[{ op: "remove", path: "/config/endpoints/missing" }], /nothing is there/u],
      [[{ op: "add", path: "/config/__proto__", value: { polluted: true } }], /names a reserved key/u],
      // Applied, but the whole result is judged as PUT judges it.
      [[{ op: "replace", path: "/config/limits/per_app/requests/per_minute", value: -1 }], /^config\.limits\.per_app\.requests\.per_minute/u],
      [[{ op: "add", path: "/config/future", value: true }], /^config: Unrecognized key/u],
      [[{ op: "replace", path: "/name", value: "   " }], /^name/u],
      // Outside the document a patch may change, or malformed.
      [[{ op: "replace", path: "/revision", value: 9 }], /^operations\.0\.path: path must be/u],
      [[{ op: "replace", path: "/id", value: "other" }], /^operations\.0\.path/u],
      [[{ op: "replace", path: "/name" }], /^operations\.0\.value: value is required/u],
      [[{ op: "move", from: "/name", path: "/status" }], /^operations\.0/u],
      [[], /^operations must name at least one change/u],
    ];
    for (const [operations, message] of refusals) {
      const refused = await patch(appId, { revision: before.revision, operations });
      expect(refused.status, JSON.stringify(operations)).toBe(400);
      expect(refused.body.error.code, JSON.stringify(operations)).toBe("invalid_request");
      expect(refused.body.error.message, JSON.stringify(operations)).toMatch(message);
    }
    expect(await read(appId)).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("applyAppPatch", () => {
  const document = () => ({ name: "A", config: { list: [1, 2], map: { "a/b": 1, "c~d": 2 } } });
  const apply = (operations: unknown[]) =>
    applyAppPatch(document(), operations as AppPatchOperation[]);

  it("decodes ~1 and ~0, and never changes its input", () => {
    const input = document();
    const result = applyAppPatch(input, [
      { op: "replace", path: "/config/map/a~1b", value: 3 },
      { op: "remove", path: "/config/map/c~0d" },
    ]);
    expect(result).toEqual({ name: "A", config: { list: [1, 2], map: { "a/b": 3 } } });
    expect(input).toEqual(document());
  });

  it("follows RFC 6902 for array positions", () => {
    expect(apply([{ op: "add", path: "/config/list/0", value: 0 }])).toMatchObject({ config: { list: [0, 1, 2] } });
    expect(apply([{ op: "add", path: "/config/list/2", value: 3 }])).toMatchObject({ config: { list: [1, 2, 3] } });
    expect(apply([{ op: "replace", path: "/config/list/1", value: 9 }])).toMatchObject({ config: { list: [1, 9] } });
    expect(() => apply([{ op: "add", path: "/config/list/3", value: 3 }])).toThrow(/the array has 2 entries/u);
    expect(() => apply([{ op: "replace", path: "/config/list/2", value: 3 }])).toThrow(/the array has 2 entries/u);
    expect(() => apply([{ op: "replace", path: "/config/list/-", value: 3 }])).toThrow(/a number, or - to append/u);
    expect(() => apply([{ op: "remove", path: "/config/list/01" }])).toThrow(/a number, or - to append/u);
  });

  it("adds over an existing key, as RFC 6902 does, and writes a value it is given by copy", () => {
    const value = { nested: true };
    const result = applyAppPatch(document(), [{ op: "add", path: "/config/map/a~1b", value }]) as any;
    expect(result.config.map["a/b"]).toEqual({ nested: true });
    value.nested = false;
    expect(result.config.map["a/b"]).toEqual({ nested: true });
  });
});
