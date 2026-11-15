// A barrel: see vitest.suites.config.ts. Nothing here but imports.
// On its own because it is the one file that reads the shipped price list
// (see test/frozen-prices.ts), and a barrel shares one catalog among its members.
import "../shipped-prices.test";
