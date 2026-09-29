import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

/**
 * workerd reads every named export of the entry module as a Durable Object or
 * entrypoint class, and the default export as the handler, and refuses to start
 * the Worker at all over an export of any other type — a string constant is
 * enough. The test pool does not load the entry that way, so without this a
 * stray export passes every other test and fails only once deployed.
 */
describe("the Worker entry module", () => {
  it("exports only the handler and classes", () => {
    const { default: handler, ...named } = entry;
    expect(Object.keys(named).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(named)) {
      expect(typeof value, name).toBe("function");
    }
    expect(typeof handler).toBe("object");
    expect(typeof handler.fetch).toBe("function");
    expect(typeof handler.scheduled).toBe("function");
  });
});
