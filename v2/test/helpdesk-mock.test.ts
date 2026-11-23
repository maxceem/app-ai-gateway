/**
 * Offline checks of the smoke checks' help desk mock (`smoke/helpdesk-mock/`):
 * it opens tickets only for the gateway, refuses a pasted credential and a
 * page that is not a URL, as the real help desk does.
 */
import { describe, expect, it } from "vitest";
import { MOCK_MARK, newReference, refusal, SERVICE_ID } from "../smoke/helpdesk-mock/index.ts";
import type { HelpdeskTicketInput } from "../src/helpdesk/contract.ts";
import { HELPDESK_SERVICE_ID } from "../src/admin/support.ts";

const TICKET: HelpdeskTicketInput = {
  serviceId: SERVICE_ID,
  kind: "bug",
  message: "Streams stop halfway.",
  customer: { email: "person@example.test" },
  channel: "console",
  page: "https://console.example.test/apps",
};

describe("the help desk mock", () => {
  it("opens the gateway's tickets, with a readable reference", () => {
    expect(SERVICE_ID).toBe(HELPDESK_SERVICE_ID);
    expect(refusal(TICKET)).toBeNull();
    expect(newReference(new Uint8Array([0, 1, 2, 3, 4, 31]))).toBe("SUP-23456Z");
  });

  it("refuses another service, a pasted credential and a page that is not a URL", () => {
    expect(refusal({ ...TICKET, serviceId: "other" })?.code).toBe("unknown_service");
    expect(refusal({ ...TICKET, message: "My key is sk-abcdefghijklmnopqrstu" })?.code).toBe("credential_detected");
    expect(refusal({ ...TICKET, context: { key: "agw_app_0123456789abcdefghij" } })?.code).toBe("credential_detected");
    expect(refusal({ ...TICKET, page: "/apps" })?.code).toBe("invalid_input");
    expect(refusal({ ...TICKET, page: "javascript:alert(1)" })?.code).toBe("invalid_input");
    // In its own words, which no real help desk says: what the smoke check's probe looks for.
    expect(refusal({ ...TICKET, message: `Smoke probe: sk-${"0".repeat(32)}` })?.message.startsWith(MOCK_MARK)).toBe(true);
  });
});
