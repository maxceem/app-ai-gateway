import { expect, vi } from "vitest";

/**
 * Every Worker test bills against a frozen copy of the price list,
 * `test/fixtures/price-list.json`, in place of the shipped
 * `src/usage/models.json`. The shipped list changes whenever a provider adds,
 * retires or reprices a model, and a test of billing logic needs some price
 * to bill with, not today's. Against the copy, a routine price-list update
 * cannot fail a test that names a model. The shipped list itself is held to
 * rules over every entry in `shipped-prices.test.ts`, the one file left
 * reading it.
 *
 * A setup file, the first one, rather than a `vi.mock` in each test file: the
 * copy must be in place before anything imports the catalog, the other setup
 * file and the Worker entry behind `exports` included, and the whole-suite run
 * loads a barrel of test files into one module registry
 * (`vitest.suites.config.ts`), where a member's own mock would come too late.
 */
const READS_SHIPPED_PRICES = /[/\\]shipped-prices\.(test|suite)\.ts$/;

if (!READS_SHIPPED_PRICES.test(expect.getState().testPath ?? "")) {
  vi.doMock("../src/usage/models.json", () => import("./fixtures/price-list.json"));
}
