/**
 * Offline checks of the smoke checks' mail mock (`smoke/mail-mock/`): it keeps
 * mail only for `example.test` addresses, so a real address never lands there.
 */
import { describe, expect, it } from "vitest";
import mailMock, { testAddress } from "../smoke/mail-mock/index.ts";

describe("the mail mock", () => {
  it("keeps mail only for example.test addresses", () => {
    expect(testAddress("smoke-1@example.test")).toBe(true);
    expect(testAddress("Smoke-1@EXAMPLE.TEST")).toBe(true);
    for (const other of ["person@example.com", "x@example.test.evil.com", "a <b@example.test>", "", 7, null]) {
      expect(testAddress(other), String(other)).toBe(false);
    }
  });

  it("reads an outbox only by a test address", async () => {
    const env = { OUTBOX: {} } as never;
    for (const path of ["/outbox?to=person@example.com", "/outbox", "/other?to=a@example.test"]) {
      expect((await mailMock.fetch(new Request(`https://mail.test${path}`), env)).status, path).toBe(404);
    }
  });
});
