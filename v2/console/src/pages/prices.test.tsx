import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PricesPage, priceRows } from "./prices";
import { renderAuthenticated } from "@/test/render";

const PRICES = {
  prices: {
    openai: {
      "gpt-b": { kind: "text", input: 2, output: 10, retirement_date: "2027-01-06" },
      "gpt-a": { kind: "text", input: 1, output: 4, unlisted_since: "2026-10-01" },
    },
    elevenlabs: { "eleven-v3": { kind: "tts", input: 100 } },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("priceRows", () => {
  it("lists one row per model, by provider and model, with what the notes need", () => {
    const rows = priceRows(PRICES.prices);
    expect(rows.map((row) => row.model)).toEqual(["eleven-v3", "gpt-a", "gpt-b"]);
    expect(rows[1]).toMatchObject({ input: 1, output: 4, unlistedSince: "2026-10-01" });
    expect(rows[0]!.output).toBeNull();
  });
});

describe("PricesPage", () => {
  it("shows each model's rates and notes, and filters them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PRICES))));
    renderAuthenticated(<PricesPage />);
    expect(await screen.findByText("gpt-b")).toBeTruthy();
    expect(screen.getByText("Retires 2027-01-06")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/filter models/i), "eleven");
    expect(screen.queryByText("gpt-b")).toBeNull();
    expect(screen.getByText("eleven-v3")).toBeTruthy();
  });
});
