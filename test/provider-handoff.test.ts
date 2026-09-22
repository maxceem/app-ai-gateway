import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createIdentityAuth } from "../src/auth/identity";
import { TEST_ORGANIZATION_ID, TEST_SERVICE_USER_ID } from "./helpers";
import { secretVault } from "../src/vault";
import { secretContext } from "../src/vault/secrets";
import { resolveDeployment } from "../src/policy/deployment";

const origin = "https://example.test";
const runtime = new Proxy(env, {
  get(target, key, receiver) {
    if (key === "DEPLOYMENT_ID") return "handoff-tests";
    if (key === "CLI_CONSOLE_ORIGIN") return origin;
    return Reflect.get(target, key, receiver);
  },
});
/**
 * An account of its own, for a test that needs the management-operation
 * allowance to itself: the counter is taken over the account, and the rest of
 * this file spends the shared one.
 */
async function seedAccount(): Promise<string> {
  const id = `handoff-account-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mgmt_organization(id,name,created_by_user_id,created_at,updated_at)
     VALUES (?,'Handoff account',?,?,?)`,
  )
    .bind(id, TEST_SERVICE_USER_ID, now, now)
    .run();
  return id;
}

async function operation(
  kind: string,
  payload: Record<string, unknown>,
  operationEnv: Env = runtime,
  organizationId: string = TEST_ORGANIZATION_ID,
) {
  const auth = createIdentityAuth(resolveDeployment(operationEnv), operationEnv, origin);
  const user = await auth.service.createServiceIdentity({ name: "Handoff test" });
  await auth.repository.addOrganizationUser({
    organizationId,
    userId: user.id,
    role: "admin",
  });
  const key = await auth.service.issueServiceApiKey({
    userId: user.id,
    organizationId,
    name: "Handoff",
  });
  const pollToken = crypto.randomUUID();
  const response = await worker.request(
    `${origin}/v1/cli/operations`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key.plaintext}`, "content-type": "application/json" },
      body: JSON.stringify({ kind, payload, pollToken }),
    },
    operationEnv,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const data = await response.json<{ id: string; url: string }>();
  const submit = (
    secret?: string,
    proof = new URL(data.url).hash.slice(1),
    suppliedOrigin = origin,
  ) =>
    worker.request(
      `${origin}/v1/cli/browser/${encodeURIComponent(data.id)}/submit`,
      {
        method: "POST",
        headers: { origin: suppliedOrigin, "content-type": "application/json" },
        body: JSON.stringify({
          submissionToken: proof,
          approve: true,
          ...(secret === undefined ? {} : { secret }),
        }),
      },
      operationEnv,
    );
  const details = () =>
    worker.request(
      `${origin}/v1/cli/browser/${encodeURIComponent(data.id)}/details`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ submissionToken: new URL(data.url).hash.slice(1) }),
      },
      operationEnv,
    );
  const poll = () =>
    worker.request(
      `${origin}/v1/cli/operations/${encodeURIComponent(data.id)}`,
      { headers: { authorization: `Bearer ${pollToken}` } },
      operationEnv,
    );
  return { ...data, submit, details, poll, user, key };
}

const providerBody = () => ({
  type: "openai",
  name: "Browser connection",
  slug: `browser-${crypto.randomUUID()}`,
});

describe("provider browser submissions", () => {
  it("creates once under replay/concurrency and never exposes the submitted secret in polling", async () => {
    const body = providerBody();
    const op = await operation("provider.add", body);
    // A provider handoff asks nothing of whoever holds the browser, so the page
    // is never told to wait for a session.
    await expect((await op.details()).json()).resolves.toMatchObject({ blockedBy: null });
    const upstream = vi.spyOn(globalThis, "fetch");
    try {
      const responses = await Promise.all([
        op.submit("browser-provider-secret"),
        op.submit("browser-provider-secret"),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      // The command that opened this page is still running, so the approval
      // sends its approver back to the terminal rather than into the console.
      await expect(responses[0]!.json()).resolves.toMatchObject({ continueTo: "cli" });
      expect((await op.submit("different-replay-secret")).status).toBe(200);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      upstream.mockRestore();
    }
    const rows = await env.DB.prepare("SELECT id,secret_blob FROM provider WHERE slug=?")
      .bind(body.slug)
      .all<{ id: string; secret_blob: string }>();
    expect(rows.results).toHaveLength(1);
    expect(
      await secretVault(env).decryptSecret(
        rows.results[0]!.secret_blob,
        secretContext("providerKey", [
          TEST_ORGANIZATION_ID,
          rows.results[0]!.id,
          "openai",
          "",
        ]),
      ),
    ).toBe("browser-provider-secret");
    const polled = await op.poll();
    const text = await polled.text();
    expect(text).toContain('"state":"completed"');
    expect(text).not.toContain("browser-provider-secret");
    expect(text).not.toContain("secretBlob");
    const challenge = await env.DB.prepare(
      "SELECT request_json,outcome FROM mgmt_handoff WHERE id=?",
    )
      .bind(op.id)
      .first();
    expect(JSON.stringify(challenge)).not.toContain("browser-provider-secret");
  });

  it("rejects wrong proof/origin and revoked initiating credentials without consumption", async () => {
    const op = await operation("provider.add", providerBody());
    expect((await op.submit("secret", crypto.randomUUID())).status).toBe(403);
    expect((await op.submit("secret", undefined, "https://attacker.test")).status).toBe(403);
    await env.DB.prepare("UPDATE mgmt_api_key SET enabled=0 WHERE id=?").bind(op.key.id).run();
    expect((await op.submit("secret")).status).toBe(409);
    expect(
      (
        await env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
          .bind(op.id)
          .first<{ consumed_at: number | null }>()
      )?.consumed_at,
    ).toBeNull();
  });

  it("rolls back submission when the initiating member is demoted before the mutation", async () => {
    const body = providerBody();
    let demoteAtCommit = false;
    let commitInterceptions = 0;
    let initiatingUserId = "";
    const db = new Proxy(runtime.DB, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: Parameters<Env["DB"]["batch"]>[0]) => {
          if (demoteAtCommit) {
            demoteAtCommit = false;
            commitInterceptions += 1;
            await env.DB.prepare(
              "UPDATE mgmt_organization_user SET role='member' WHERE organization_id=? AND user_id=?",
            )
              .bind(TEST_ORGANIZATION_ID, initiatingUserId)
              .run();
          }
          return target.batch(statements);
        };
      },
    });
    const interleavedEnv = new Proxy(runtime, {
      get(target, property, receiver) {
        return property === "DB" ? db : Reflect.get(target, property, receiver);
      },
    }) as Env;
    const op = await operation("provider.add", body, interleavedEnv);
    initiatingUserId = op.user.id;
    demoteAtCommit = true;

    expect((await op.submit("secret-after-demotion")).status).toBe(409);
    expect(commitInterceptions).toBe(1);
    expect(
      (
        await env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
          .bind(op.id)
          .first<{ consumed_at: number | null }>()
      )?.consumed_at,
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM provider WHERE slug=?")
        .bind(body.slug)
        .first("n"),
    ).toBe(0);
  });

  it("keeps rotation bound to the reviewed provider configuration", async () => {
    const create = await operation("provider.add", providerBody());
    expect((await create.submit("initial-secret")).status).toBe(200);
    const { result } = await (await create.poll()).json<{ result: { provider: { id: string } } }>();
    const rotate = await operation("provider.rotate-key", { id: result.provider.id });
    const reviewed = await (await rotate.details()).json<{ payload: Record<string, any> }>();
    expect(reviewed.payload.snapshot).toMatchObject({
      id: result.provider.id,
      name: "Browser connection",
      baseUrl: null,
    });
    expect(JSON.stringify(reviewed.payload)).not.toContain("expectedRevision");
    expect(JSON.stringify(reviewed.payload)).not.toContain("__requestHash");
    await env.DB.prepare(
      "UPDATE provider SET base_url='https://changed.example.com',revision=revision+1,updated_at=? WHERE id=?",
    )
      .bind(new Date(Date.now() + 1000).toISOString(), result.provider.id)
      .run();
    expect((await rotate.submit("new-secret")).status).toBe(409);
    expect(
      (
        await env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
          .bind(rotate.id)
          .first<{ consumed_at: number | null }>()
      )?.consumed_at,
    ).toBeNull();
  });

  it("rejects invalid, stale, and caller-supplied internal revision snapshots", async () => {
    const create = await operation("provider.add", providerBody());
    expect((await create.submit("initial-secret")).status).toBe(200);
    const { result } = await (await create.poll()).json<{ result: { provider: { id: string; revision: number } } }>();
    const request = (payload: Record<string, unknown>) => worker.request(
      `${origin}/v1/cli/operations`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${create.key.plaintext}`, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "provider.rotate-key",
          payload,
          pollToken: crypto.randomUUID(),
        }),
      },
      runtime,
    );
    expect((await request({ id: result.provider.id, revision: "1" })).status).toBe(400);
    expect((await request({ id: result.provider.id, revision: result.provider.revision + 1 })).status).toBe(409);
    expect((await request({ id: result.provider.id, snapshot: { revision: result.provider.revision } })).status).toBe(400);
    expect((await request({ id: result.provider.id, expectedRevision: result.provider.revision })).status).toBe(400);
  });

  it("keeps a provider submission pending when its reviewed gateway changes", async () => {
    const createGateway = await operation("provider-gateway.add", {
      type: "vercel",
      name: "Reviewed gateway",
    });
    expect((await createGateway.submit("gateway-secret")).status).toBe(200);
    const { result } = await (await createGateway.poll()).json<{ result: { gateway: { id: string } } }>();
    const add = await operation("provider.add", {
      type: "openai",
      name: "Bound provider",
      slug: `bound-${crypto.randomUUID()}`,
      providerGatewayId: result.gateway.id,
    });
    await env.DB.prepare("UPDATE provider_gateway SET revision=revision+1 WHERE id=?")
      .bind(result.gateway.id)
      .run();
    expect((await add.submit()).status).toBe(409);
    expect((await env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
      .bind(add.id)
      .first<{ consumed_at: number | null }>())?.consumed_at).toBeNull();
  });

  it("creates and rotates a shared gateway through the same atomic path", async () => {
    const create = await operation("provider-gateway.add", {
      type: "vercel",
      name: "Browser gateway",
    });
    expect((await create.submit("gateway-first-secret")).status).toBe(200);
    const { result } = await (await create.poll()).json<{ result: { gateway: { id: string } } }>();
    const rotate = await operation("provider-gateway.rotate-key", { id: result.gateway.id });
    expect((await rotate.submit("gateway-second-secret")).status).toBe(200);
    const response = await (await rotate.poll()).text();
    expect(response).toContain('"state":"completed"');
    expect(response).not.toContain("gateway-second-secret");
    expect((await create.submit("replayed")).status).toBe(200);
  });

  it("leaves the handoff pending when the guarded write matches no row, and replays a recorded success", async () => {
    const account = await seedAccount();
    const create = await operation(
      "provider-gateway.add",
      { type: "vercel", name: "Moving gateway" },
      runtime,
      account,
    );
    expect((await create.submit("gateway-first-secret")).status).toBe(200);
    const { result } = await (await create.poll()).json<{
      result: { gateway: { id: string; secretHint: string } };
    }>();
    // A submission that already landed answers with what it recorded rather
    // than writing a second time.
    const replay = await create.submit("gateway-first-secret");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ continueTo: "cli" });

    // The reviewed revision moves after the service has read it and before its
    // guarded UPDATE runs, so the write matches no row for a reason none of the
    // handoff's own conditions can see. Consumption rides on that write, so it
    // must not land either.
    let moveAtCommit = false;
    const db = new Proxy(runtime.DB, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: Parameters<Env["DB"]["batch"]>[0]) => {
          if (moveAtCommit) {
            moveAtCommit = false;
            await env.DB.prepare("UPDATE provider_gateway SET revision=revision+1 WHERE id=?")
              .bind(result.gateway.id)
              .run();
          }
          return target.batch(statements);
        };
      },
    });
    const interleavedEnv = new Proxy(runtime, {
      get(target, property, receiver) {
        return property === "DB" ? db : Reflect.get(target, property, receiver);
      },
    }) as Env;
    const rotate = await operation(
      "provider-gateway.rotate-key",
      { id: result.gateway.id },
      interleavedEnv,
      account,
    );
    moveAtCommit = true;
    const refused = await rotate.submit("gateway-second-secret");
    expect(refused.status).toBe(409);
    // The refusal the guarded write reaches, not the one the service's own
    // revision read would have answered before the batch was built.
    await expect(refused.json()).resolves.toMatchObject({
      error: { message: "The resource or its authorization changed; start a new submission" },
    });
    expect(
      (
        await env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
          .bind(rotate.id)
          .first<{ consumed_at: number | null }>()
      )?.consumed_at,
    ).toBeNull();
    await expect((await rotate.poll()).json()).resolves.toMatchObject({ state: "pending" });
    expect(
      await env.DB.prepare("SELECT secret_hint FROM provider_gateway WHERE id=?")
        .bind(result.gateway.id)
        .first("secret_hint"),
    ).toBe(result.gateway.secretHint);
  });
});

describe("direct provider creation receipts", () => {
  it("returns the winning provider and gateway after concurrent retries without duplicates", async () => {
    const auth = createIdentityAuth(resolveDeployment(runtime), runtime, origin);
    const user = await auth.service.createServiceIdentity({ name: "Receipt service" });
    await auth.repository.addOrganizationUser({
      organizationId: TEST_ORGANIZATION_ID,
      userId: user.id,
      role: "admin",
    });
    const key = await auth.service.issueServiceApiKey({
      userId: user.id,
      organizationId: TEST_ORGANIZATION_ID,
      name: "Receipts",
    });
    for (const [path, body, resultName] of [
      ["providers", { ...providerBody(), secret: "direct-provider-secret" }, "provider"],
      [
        "provider-gateways",
        { type: "vercel", name: "Receipt gateway", token: "direct-gateway-secret" },
        "gateway",
      ],
    ] as const) {
      const headers = {
        authorization: `Bearer ${key.plaintext}`,
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Idempotency-Proof": crypto.randomUUID(),
      };
      const call = (payload: unknown = body, suppliedHeaders = headers) =>
        worker.request(
          `${origin}/v1/admin/${path}`,
          { method: "POST", headers: suppliedHeaders, body: JSON.stringify(payload) },
          runtime,
        );
      const responses = await Promise.all([call(), call()]);
      for (const response of responses)
        expect(response.status, await response.clone().text()).toBe(201);
      const values = await Promise.all(
        responses.map((response) => response.json<Record<string, { id: string }>>()),
      );
      expect(values[0]![resultName]!.id).toBe(values[1]![resultName]!.id);
      const replay = await call();
      expect((await replay.json<Record<string, { id: string }>>())[resultName]!.id).toBe(
        values[0]![resultName]!.id,
      );
      expect((await call({ ...body, name: "Changed request" })).status).toBe(409);
      expect(
        (await call(body, { ...headers, "X-Idempotency-Proof": crypto.randomUUID() })).status,
      ).toBe(403);
      const table = resultName === "provider" ? "provider" : "provider_gateway";
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id=?`)
          .bind(values[0]![resultName]!.id)
          .first("n"),
      ).toBe(1);
    }
  });
});
