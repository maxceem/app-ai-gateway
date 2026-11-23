/**
 * Step 2b: people's sign-in on v2 (cf-auth 1.0). The console session, the
 * OAuth server for the CLI and MCP clients (the device flow and the loopback
 * code flow), management keys and sign-ins on the access page, the console's
 * pages, and that none of it is on a provider request's cold start.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { OAUTH_PATHS } from "../src/management/oauth-routes.ts";
import { sweepSignIn } from "../src/management/maintenance.ts";
import { createIdentity, CLI_CLIENT_ID } from "../src/auth/identity.ts";
import { LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const CONSOLE = "https://console.gateway.test";
const API = "https://gateway.test";
const ISSUER = `${CONSOLE}/v2`;

interface Call {
  method?: string;
  origin?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  environment?: Env;
  /** The host to call; the console's by default. */
  base?: string;
}

async function call(path: string, options: Call = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(options.form).toString();
  }
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${options.base ?? CONSOLE}${path}`, { method: options.method ?? (body === undefined ? "GET" : "POST"), headers, body, redirect: "manual" }),
    options.environment ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A console call: the console's origin, the person's cookie, and `x-console-request`. */
function asConsole(cookie: string, path: string, options: Call = {}): Promise<Response> {
  return call(path, { origin: CONSOLE, ...options, headers: { cookie, "x-console-request": "1", ...options.headers } });
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** Starts a CLI sign-in without a browser. */
async function startDevice(): Promise<{ device_code: string; user_code: string; verification_uri: string; interval: number }> {
  const response = await call(OAUTH_PATHS.deviceAuthorization, { form: { client_id: CLI_CLIENT_ID, scope: "manage" } });
  expect(response.status).toBe(200);
  return response.json();
}

/** Polls for the tokens, as a CLI would after waiting the interval. */
async function pollDevice(deviceCode: string): Promise<Response> {
  await env.DB.prepare("UPDATE mgmt_operation SET updated_at = updated_at - 60000 WHERE id LIKE 'oauth-device-%'").run();
  return call(OAUTH_PATHS.token, {
    form: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: CLI_CLIENT_ID },
  });
}

describe("lazy loading", () => {
  // Every source file, as text, read when the test is built.
  const sources = (import.meta as ImportMeta & {
    glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
  }).glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

  /** The files the entry module reaches through static imports (type-only imports are erased). */
  function staticGraph(): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      if (files.has(file)) return;
      files.add(file);
      if (file.endsWith(".json")) return;
      const text = sources[file];
      if (text === undefined) throw new Error(`no source for ${file}`);
      const statements = text.match(/^(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)";/gmsu) ?? [];
      for (const statement of statements) {
        const target = /from\s+"([^"]+)";$/u.exec(statement)![1]!;
        if (!target.startsWith(".")) {
          packages.add(target);
          continue;
        }
        const resolved = new URL(target, `https://src.test/${file.slice(3)}`).pathname.slice(1);
        visit(`../${resolved}`);
      }
    };
    visit("../src/index.ts");
    return { files, packages };
  }

  it("keeps the management code, MCP, their schemas and the sign-in library off a provider request's path", () => {
    const { files, packages } = staticGraph();
    expect(files.size).toBeGreaterThan(20);
    const reached = [...files].filter((file) =>
      /^\.\.\/src\/(management|admin|mcp)\//u.test(file)
      || ["../src/auth/identity.ts", "../src/contracts/catalog.ts", "../src/contracts/admin.ts", "../src/contracts/access.ts", "../src/contracts/cli.ts"].includes(file),
    );
    expect(reached).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("@maxceem/cf-auth") && name !== "@maxceem/cf-auth/schema")).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("better-auth"))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("@modelcontextprotocol"))).toEqual([]);
  });
});

describe("OAuth discovery", () => {
  it("publishes the issuer on /v2, with the device flow, on the console's host only", async () => {
    const response = await call(OAUTH_PATHS.authorizationServerMetadata);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(metadata.device_authorization_endpoint).toBe(`${ISSUER}/oauth/device_authorization`);
    const resource = (await (await call(OAUTH_PATHS.protectedResourceMetadata[0].path)).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(ISSUER);
    expect((await call(OAUTH_PATHS.authorizationServerMetadata, { base: API })).status).toBe(404);
  });

  it("answers only on the console's exact origin, not plain HTTP on the same name", async () => {
    const plainHttp = "http://console.gateway.test";
    expect((await call(OAUTH_PATHS.authorizationServerMetadata, { base: plainHttp })).status).toBe(404);
    const token = await call(OAUTH_PATHS.token, { base: plainHttp, form: { grant_type: "refresh_token" } });
    expect(token.status).toBe(404);
  });

  it("mounts exactly the paths cf-auth names", async () => {
    const identity = await createIdentity(env, CONSOLE);
    const paths = identity.oauth.routePaths();
    expect(OAUTH_PATHS.authorizationServerMetadata).toBe(paths.authorizationServerMetadata);
    expect(OAUTH_PATHS.protectedResourceMetadata).toEqual(paths.protectedResourceMetadata);
    expect([OAUTH_PATHS.authorize, OAUTH_PATHS.token, OAUTH_PATHS.revoke, OAUTH_PATHS.deviceAuthorization]).toEqual([
      paths.authorize,
      paths.token,
      paths.revoke,
      paths.deviceAuthorization,
    ]);
  });

  it("drops an OAUTH_CLIENTS entry that reuses the CLI's id, and keeps serving", async () => {
    const clients = JSON.stringify([
      { clientId: CLI_CLIENT_ID, name: "Impostor", redirectUris: ["https://a.test/cb"] },
      { clientId: "other-client", name: "Other", redirectUris: ["https://b.test/cb"] },
    ]);
    const environment = { ...env, OAUTH_CLIENTS: clients } as Env;
    const key = await seedManagementKey();
    const session = await call("/v2/admin/session", { base: API, headers: { authorization: `Bearer ${key}` }, environment });
    expect(session.status).toBe(200);
    expect((await call(OAUTH_PATHS.authorizationServerMetadata, { environment })).status).toBe(200);
    const identity = await createIdentity(environment, CONSOLE);
    expect(identity.config.oauth?.clients.map((client) => client.clientId)).toContain("other-client");
  });

  it("runs no OAuth without a console origin", async () => {
    const plain = { ...env, CONSOLE_ORIGIN: "" } as Env;
    expect((await call(OAUTH_PATHS.authorizationServerMetadata, { environment: plain })).status).toBe(404);
    const capabilities = (await (await call("/v2/console/capabilities", { environment: plain })).json()) as Record<string, unknown>;
    expect(capabilities.oauth).toBe(false);
  });
});

describe("console sign-in", () => {
  it("signs up with a password where the deployment admits the email, and the session reaches the management API", async () => {
    const email = `new-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const signUp = (environment: Env) =>
      call("/v2/auth/sign-up/email", { origin: CONSOLE, json: { email, password: "correct horse battery staple", name: "New" }, environment });
    // A self-hosted deployment admits only the emails it lists.
    const refused = await signUp(env);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("registration_disabled");
    const admitted = await signUp({ ...env, ALLOWED_REGISTRATION_EMAILS: email } as Env);
    expect(admitted.status).toBe(200);
    const cookie = admitted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).toContain("agw2_identity_auth.session_token=");

    const session = await asConsole(cookie, "/v2/admin/session");
    expect(session.status).toBe(200);
    const body = (await session.json()) as { session: Record<string, any> };
    expect(body.session.user.email).toBe(email);
    expect(body.session.credentialType).toBe("session");
    expect(body.session.role).toBe("owner");
    // The new account serves traffic: this deployment verifies no addresses, so nothing marks it as waiting.
    const pending = await env.DB.prepare("SELECT 1 FROM email_pending_verification WHERE email = lower(?)").bind(email).first();
    expect(pending).toBeNull();

    // A cookie alone is not enough: a page on another site could send it.
    const bare = await call("/v2/admin/session", { headers: { cookie } });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain('realm="management"');
  });

  it("lets a console session through a non-Bearer Authorization header, such as a proxy's Basic", async () => {
    const human = await seedHuman();
    const proxied = await asConsole(human.cookie, "/v2/admin/session", { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(proxied.status).toBe(200);
    // A Bearer value that is not a key or a token is still refused.
    const wrong = await asConsole(human.cookie, "/v2/admin/session", { headers: { authorization: "Bearer not-a-key" } });
    expect(wrong.status).toBe(401);
  });

  it("lists the person's accounts and switches between them", async () => {
    const human = await seedHuman();
    const listed = (await (await asConsole(human.cookie, "/v2/admin/accounts")).json()) as { accounts: { id: string }[] };
    expect(listed.accounts.map((account) => account.id)).toEqual([human.accountId]);
    const switched = await asConsole(human.cookie, "/v2/admin/accounts/select", { json: { accountId: human.accountId } });
    expect(switched.status).toBe(200);
    const refused = await asConsole(human.cookie, "/v2/admin/accounts/select", { json: { accountId: "acc_someone_else" } });
    expect(refused.status).toBe(403);
  });
});

describe("management keys and sign-ins", () => {
  it("are created, listed and revoked by a person in the console, never by a key", async () => {
    const human = await seedHuman();
    const created = await asConsole(human.cookie, "/v2/admin/management-keys", { json: { name: "CI", grant: "read" } });
    expect(created.status).toBe(201);
    const { credential, key } = (await created.json()) as { credential: Record<string, any>; key: string };
    expect(key.startsWith("agw_mgmt_")).toBe(true);
    expect(credential).toMatchObject({ kind: "management_key", name: "CI", grant: "read", hint: key.slice(-4), clientId: null });

    // The key works, with its read grant.
    const read = await call("/v2/admin/apps", { base: API, headers: { authorization: `Bearer ${key}` } });
    expect(read.status).toBe(200);
    // A key can neither list nor mint keys.
    const minted = await call("/v2/admin/management-keys", { base: API, json: { name: "x" }, headers: { authorization: `Bearer ${key}` } });
    expect(minted.status).toBe(403);
    expect(((await minted.json()) as { error: { code: string } }).error.code).toBe("session_required");

    const listed = (await (await asConsole(human.cookie, "/v2/admin/credentials")).json()) as { credentials: { id: string }[] };
    expect(listed.credentials.map((entry) => entry.id)).toContain(credential.id);
    const revoked = await asConsole(human.cookie, `/v2/admin/credentials/${credential.id}/revoke`, { method: "POST" });
    expect(revoked.status).toBe(200);
    expect((await call("/v2/admin/apps", { base: API, headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
  });

  it("still lets an existing management key manage the account", async () => {
    const key = await seedManagementKey();
    const response = await call("/v2/admin/session", { base: API, headers: { authorization: `bearer ${key}` } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: { credentialType: string } }).session.credentialType).toBe("apiKey");
  });
});

describe("each console tab keeps its own account", () => {
  /** The person seeded, plus a second account they own. */
  async function twoAccounts() {
    const human = await seedHuman();
    const other = `acc_tab_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Other', ?, ?, ?)").bind(other, human.userId, now, now),
      env.DB.prepare(
        "INSERT INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'owner', 'active', ?)",
      ).bind(`mem_${other}`, other, human.userId, now),
    ]);
    return { ...human, other };
  }
  const tab = (cookie: string, accountId: string) => (path: string, options: Call = {}) =>
    asConsole(cookie, path, { ...options, headers: { "x-account-id": accountId, ...options.headers } });
  const apiKeyConfig = { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } };

  it("acts in the account each tab names, side by side on one sign-in", async () => {
    const human = await twoAccounts();
    const first = tab(human.cookie, human.accountId);
    const second = tab(human.cookie, human.other);
    const sessionOf = async (open: ReturnType<typeof tab>) => ((await (await open("/v2/admin/session")).json()) as { session: { account: { id: string } } }).session.account.id;
    expect(await sessionOf(first)).toBe(human.accountId);
    expect(await sessionOf(second)).toBe(human.other);
    // An app made in each tab lands in that tab's account.
    const made = async (open: ReturnType<typeof tab>, name: string) =>
      ((await (await open("/v2/admin/apps", { json: { name, config: apiKeyConfig } })).json()) as { app: { id: string } }).app.id;
    const inFirst = await made(first, "First");
    const inSecond = await made(second, "Second");
    const listed = async (open: ReturnType<typeof tab>) =>
      ((await (await open("/v2/admin/apps")).json()) as { apps: { id: string }[] }).apps.map((app) => app.id);
    expect(await listed(first)).toEqual([inFirst]);
    expect(await listed(second)).toEqual([inSecond]);
    // A delete from the second tab acts on the second account only: the first tab's app is not there to delete.
    expect((await second(`/v2/admin/apps/${inFirst}?confirm=${inFirst}`, { method: "DELETE" })).status).toBe(404);
    expect((await second(`/v2/admin/apps/${inSecond}?confirm=${inSecond}`, { method: "DELETE" })).status).toBe(200);
    expect(await listed(first)).toEqual([inFirst]);
    expect(await listed(second)).toEqual([]);
  });

  it("refuses a tab naming an account the person is not a member of", async () => {
    const human = await seedHuman();
    const refused = await tab(human.cookie, "acc_someone_else")("/v2/admin/session");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("account_forbidden");
  });

  it("opens a new tab on the account last switched to, and never moves a tab that names its own", async () => {
    const human = await twoAccounts();
    const switched = await tab(human.cookie, human.accountId)("/v2/admin/accounts/select", { json: { accountId: human.other } });
    expect(switched.status).toBe(200);
    // The browser keeps the cookies the answer set, in place of those of the same name.
    const jar = new Map(human.cookie.split(/;\s*/u).map((pair) => [pair.split("=")[0]!, pair] as const));
    for (const set of switched.headers.getSetCookie()) {
      const pair = set.split(";")[0]!;
      jar.set(pair.split("=")[0]!, pair);
    }
    const cookie = [...jar.values()].join("; ");
    const accountOf = async (response: Response) => ((await response.json()) as { session: { account: { id: string } } }).session.account.id;
    // A new tab names no account yet: it opens on the one last switched to.
    expect(await accountOf(await asConsole(cookie, "/v2/admin/session"))).toBe(human.other);
    // A tab still on the first account stays on it.
    expect(await accountOf(await tab(cookie, human.accountId)("/v2/admin/session"))).toBe(human.accountId);
  });

  it("is ignored for a management key, which acts in its own account", async () => {
    const key = await seedManagementKey();
    const response = await call("/v2/admin/session", { base: API, headers: { authorization: `Bearer ${key}`, "x-account-id": "acc_someone_else" } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { session: { credentialType: string } }).session.credentialType).toBe("apiKey");
  });
});

describe("CLI sign-in without a browser (device flow)", () => {
  it("waits for a person, then gives the CLI a token that can be revoked", async () => {
    const device = await startDevice();
    expect(device.verification_uri).toBe(`${CONSOLE}/v2/device`);
    const pending = await pollDevice(device.device_code);
    expect(pending.status).toBe(400);
    expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");

    const human = await seedHuman();
    const lookup = await asConsole(human.cookie, "/v2/console/device/lookup", { json: { userCode: device.user_code.toLowerCase() } });
    expect(lookup.status).toBe(200);
    const { id } = (await lookup.json()) as { id: string };
    const details = (await (await asConsole(human.cookie, `/v2/console/device/${id}`, { json: { userCode: device.user_code } })).json()) as Record<string, any>;
    expect(details.client.id).toBe(CLI_CLIENT_ID);
    expect(details.userCode).toBe(device.user_code);
    expect(details.accounts).toEqual([expect.objectContaining({ id: human.accountId, role: "owner" })]);
    const approved = await asConsole(human.cookie, `/v2/console/device/${id}/approve`, {
      json: { userCode: device.user_code, accountId: human.accountId, grant: "manage" },
    });
    expect(approved.status).toBe(200);

    const issued = await pollDevice(device.device_code);
    expect(issued.status).toBe(200);
    const tokens = (await issued.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.access_token.startsWith("agw_oat_")).toBe(true);
    expect(tokens.scope).toBe("manage");

    const session = await call("/v2/admin/session", { base: API, headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { session: { credentialType: string; account: { id: string } } }).session).toMatchObject({
      credentialType: "oauth",
      account: { id: human.accountId },
    });

    // The access page shows it as a CLI login, and revoking it ends it.
    const listed = (await (await asConsole(human.cookie, "/v2/admin/credentials")).json()) as { credentials: Record<string, any>[] };
    const login = listed.credentials.find((entry) => entry.kind === "cli");
    expect(login).toMatchObject({ clientId: CLI_CLIENT_ID, hint: null, grant: "manage" });
    await asConsole(human.cookie, `/v2/admin/credentials/${login!.id}/revoke`, { method: "POST" });
    const after = await call("/v2/admin/apps", { base: API, headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("takes the code-entry page's calls only from the console's own page", async () => {
    const human = await seedHuman();
    const elsewhere = await asConsole(human.cookie, "/v2/console/device/lookup", { json: { userCode: "ABCD-EFGH" }, origin: "https://evil.test" });
    expect(elsewhere.status).toBe(403);
    const apiHost = await asConsole(human.cookie, "/v2/console/device/lookup", { json: { userCode: "ABCD-EFGH" }, base: API, origin: API });
    expect(apiHost.status).toBe(404);
    const unknown = await asConsole(human.cookie, "/v2/console/device/lookup", { json: { userCode: "ABCD-EFGH" } });
    expect(unknown.status).toBe(404);
    // Nobody signed in: the person must sign in first.
    const anonymous = await call("/v2/console/device/lookup", { origin: CONSOLE, json: { userCode: "ABCD-EFGH" } });
    expect(anonymous.status).toBe(401);
  });

  it("lets anyone holding the code decline it", async () => {
    const device = await startDevice();
    const human = await seedHuman();
    const { id } = (await (await asConsole(human.cookie, "/v2/console/device/lookup", { json: { userCode: device.user_code } })).json()) as { id: string };
    const denied = await call(`/v2/console/device/${id}/deny`, { origin: CONSOLE, json: { userCode: device.user_code } });
    expect(denied.status).toBe(200);
    const poll = await pollDevice(device.device_code);
    expect(((await poll.json()) as { error: string }).error).toBe("access_denied");
  });
});

describe("CLI sign-in with a browser (loopback code flow)", () => {
  it("goes through the console's consent page and back to the CLI's local port", async () => {
    const { verifier, challenge } = await pkce();
    const redirectUri = "http://127.0.0.1:53124/callback";
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLI_CLIENT_ID,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: ISSUER,
      state: "xyz",
    });
    const authorize = await call(`${OAUTH_PATHS.authorize}?${query}`);
    expect(authorize.status).toBe(302);
    const consent = new URL(authorize.headers.get("location")!, CONSOLE);
    expect(consent.pathname).toBe("/v2/oauth/consent");
    const id = consent.searchParams.get("id")!;
    const proof = consent.hash.slice(1);

    const human = await seedHuman();
    const details = (await (await asConsole(human.cookie, `/v2/console/oauth/consents/${id}`, { json: { proof } })).json()) as Record<string, any>;
    expect(details).toMatchObject({ client: { id: CLI_CLIENT_ID }, redirectHost: "127.0.0.1:53124", blockedBy: null });
    // Nobody signed in sees that they must.
    const anonymous = (await (await call(`/v2/console/oauth/consents/${id}`, { origin: CONSOLE, json: { proof } })).json()) as Record<string, any>;
    expect(anonymous.blockedBy).toBe("sign_in_required");

    const allowed = await asConsole(human.cookie, `/v2/console/oauth/consents/${id}/allow`, {
      json: { proof, accountId: human.accountId, grant: "read" },
    });
    expect(allowed.status).toBe(200);
    const back = new URL(((await allowed.json()) as { redirect: string }).redirect);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("xyz");

    const exchanged = await call(OAUTH_PATHS.token, {
      form: {
        grant_type: "authorization_code",
        code: back.searchParams.get("code")!,
        redirect_uri: redirectUri,
        client_id: CLI_CLIENT_ID,
        code_verifier: verifier,
      },
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe("read");
    const reader = { authorization: `Bearer ${tokens.access_token}` };
    expect((await call("/v2/admin/apps", { base: API, headers: reader })).status).toBe(200);
    const write = await call("/v2/admin/providers", { base: API, headers: reader, json: { type: "openai" } });
    expect(write.status).toBe(403);
    expect(write.headers.get("www-authenticate")).toContain('error="insufficient_scope"');

    // `agw logout`: revoking the refresh token ends the whole connection.
    const logout = await call(OAUTH_PATHS.revoke, { form: { token: tokens.refresh_token, client_id: CLI_CLIENT_ID } });
    expect(logout.status).toBe(200);
    expect((await call("/v2/admin/apps", { base: API, headers: reader })).status).toBe(401);
  });

  it("refuses a browser origin that is not the console's", async () => {
    const response = await call(OAUTH_PATHS.token, { origin: "https://evil.test", form: { grant_type: "refresh_token" } });
    expect(response.status).toBe(403);
  });
});

describe("the hourly clean-up", () => {
  it("runs the sign-in library's sweeps", async () => {
    expect(await sweepSignIn(env)).toEqual({ oauth: true });
  });
});
