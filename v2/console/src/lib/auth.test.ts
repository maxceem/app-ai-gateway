import { afterEach, describe, expect, it, vi } from "vitest";
import { signOut, startGoogleSignIn } from "./auth";

function stubSocial(url = "https://accounts.google.test/o/oauth2/auth") {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ redirect: true, url }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
  return fetchMock;
}

function socialBody(fetchMock: ReturnType<typeof stubSocial>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/sign-in/social"));
  return JSON.parse(String(call![1]!.body));
}

afterEach(() => vi.unstubAllGlobals());

describe("signOut", () => {
  it("posts a JSON body so better-call does not reject the request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    // A bodyless POST is answered 415 by better-call and leaves the session up.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/v1/auth/sign-out");
    expect(init!.body).toBe("{}");
    expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  });
});

describe("startGoogleSignIn", () => {
  it("returns to the console landing page by default", async () => {
    const fetchMock = stubSocial();
    await startGoogleSignIn();

    expect(socialBody(fetchMock)).toMatchObject({
      provider: "google",
      callbackURL: "/apps",
      errorCallbackURL: "/login",
    });
  });

  it("carries a deep link through both outcomes", async () => {
    const fetchMock = stubSocial();
    await startGoogleSignIn("/apps/my-app/usage");

    // A failed Google sign-in must not cost the operator their destination.
    expect(socialBody(fetchMock)).toMatchObject({
      callbackURL: "/apps/my-app/usage",
      errorCallbackURL: "/login?from=%2Fapps%2Fmy-app%2Fusage",
    });
  });

  it("refuses to hand the provider an off-origin destination", async () => {
    const fetchMock = stubSocial();
    await startGoogleSignIn("https://evil.example/steal");

    // The return path arrives from the URL, so it is sanitized, not trusted.
    expect(socialBody(fetchMock)).toMatchObject({
      callbackURL: "/apps",
      errorCallbackURL: "/login",
    });
  });

  it("refuses a protocol-relative destination", async () => {
    const fetchMock = stubSocial();
    await startGoogleSignIn("//evil.example");

    expect(socialBody(fetchMock)).toMatchObject({ callbackURL: "/apps" });
  });

  it("navigates to the provider URL", async () => {
    stubSocial("https://accounts.google.test/authorize?x=1");
    await startGoogleSignIn();

    expect(window.location.assign).toHaveBeenCalledWith("https://accounts.google.test/authorize?x=1");
  });

  it("reports a missing provider URL rather than navigating nowhere", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ redirect: false }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startGoogleSignIn()).rejects.toThrow(/unavailable/i);
  });
});
