import { expect, test } from "vitest";
import { call, smokeId } from "../../../src/gateway.ts";
import { MODEL } from "../../../src/mock/formats.ts";
import { env, errorCode, expectForwardedCleanly, observed, state } from "../../support.ts";

// A realtime key request is judged before it is forwarded: the session's models
// against the app's policy, and the key's lifetime against a cap. The mock has
// no realtime route, so these checks only ask whether a request reached it;
// they never see, and so never print, a minted key.
const proxy = (path: string) => `/v1/apps/${state.apps.realtime.id}/proxy/smoke-openai/${path}`;
const key = state.apps.realtime.key;

/** A transcription mint carrying `id` where the mock finds it, in the transcription prompt. */
function transcriptionMint(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: {
      type: "transcription",
      audio: { input: { transcription: { model: MODEL, prompt: id } } },
    },
    ...extra,
  };
}

async function expectRefusedBeforeProvider(response: Response, id: string, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await errorCode(response)).toBe(code);
  await expect(observed(id)).rejects.toThrow("never received");
}

test("a transcription key request on the fixed model reaches the provider", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/realtime/client_secrets"), { key, body: transcriptionMint(id) });
  await response.body?.cancel();
  await expectForwardedCleanly(id, "v1/realtime/client_secrets");
});

test("a key request for a model other than the fixed one is refused", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/realtime/client_secrets"), {
    key,
    body: {
      session: {
        type: "realtime",
        model: "smoke-not-the-fixed-model",
        audio: { input: { transcription: { model: MODEL, prompt: id } } },
      },
    },
  });
  await expectRefusedBeforeProvider(response, id, 403, "model_not_allowed");
});

test("a key lifetime above the cap is refused", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/realtime/client_secrets"), {
    key,
    body: transcriptionMint(id, { expires_after: { anchor: "created_at", seconds: 7200 } }),
  });
  await expectRefusedBeforeProvider(response, id, 400, "invalid_request");
});

test("the older session endpoint is refused even when listed", async () => {
  const id = smokeId();
  const response = await call(env, proxy("v1/realtime/sessions"), { key, body: transcriptionMint(id) });
  await expectRefusedBeforeProvider(response, id, 403, "path_not_allowed");
});
