import assert from "node:assert/strict";
import { test } from "node:test";
import { origin } from "../src/env.ts";

// Every address the checks build paths on is an origin. A path is refused
// rather than dropped, so a misconfigured mock fails at once instead of the
// checks quietly talking to another one.

test("an origin is kept, with or without a trailing slash", () => {
  assert.equal(origin("https://probe.example.com", "SMOKE_MOCK_URL"), "https://probe.example.com");
  assert.equal(origin("https://probe.example.com/", "SMOKE_MOCK_URL"), "https://probe.example.com");
  assert.equal(origin("http://127.0.0.1:8787", "SMOKE_MOCK_URL"), "http://127.0.0.1:8787");
});

test("a path, query or fragment is refused, naming the variable", () => {
  for (const raw of ["https://probe.example.com/compat", "https://probe.example.com/compat/", "https://probe.example.com/?a=1", "https://probe.example.com/#x"]) {
    assert.throws(() => origin(raw, "SMOKE_MOCK_URL"), /SMOKE_MOCK_URL must be an origin, such as https:\/\/probe\.example\.com, with no path/u);
  }
});

test("anything but an absolute http(s) URL is refused", () => {
  assert.throws(() => origin("probe.example.com", "SMOKE_GATEWAY_URL"), /SMOKE_GATEWAY_URL must be an absolute URL/u);
  assert.throws(() => origin("ftp://probe.example.com", "SMOKE_GATEWAY_URL"), /must be an http\(s\) URL/u);
});

test("the log reader needs both its token and its account, or neither", async () => {
  const { smokeEnv } = await import("../src/env.ts");
  const saved = { ...process.env };
  try {
    process.env.SMOKE_GATEWAY_URL = "https://ai.example.com";
    delete process.env.SMOKE_CF_API_TOKEN;
    delete process.env.SMOKE_CF_ACCOUNT_ID;
    delete process.env.SMOKE_CF_WORKER;
    assert.equal(smokeEnv().cloudflare, undefined);
    process.env.SMOKE_CF_API_TOKEN = "token";
    assert.throws(() => smokeEnv(), /Set both SMOKE_CF_API_TOKEN and SMOKE_CF_ACCOUNT_ID, or neither/u);
    process.env.SMOKE_CF_ACCOUNT_ID = "account";
    assert.deepEqual(smokeEnv().cloudflare, { apiToken: "token", accountId: "account", workerName: "app-ai-gateway" });
  } finally {
    process.env = saved;
  }
});
