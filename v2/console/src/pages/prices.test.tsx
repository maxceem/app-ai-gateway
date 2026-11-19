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
      "gpt-long": { kind: "text", input: 8, output: 40, long_input: 16, long_output: 60, long_context_threshold: 272000 },
    },
    elevenlabs: { "eleven-v3": { kind: "tts", input: 100 } },
    realtime: { "gpt-realtime-whisper": { kind: "realtime", per_minute: 0.017 }, "img-1": { kind: "image", per_image: 0.04, per_hour: 1.5 } },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("priceRows", () => {
  it("lists one row per model, by provider and model, with what the notes need", () => {
    const rows = priceRows(PRICES.prices);
    expect(rows.map((row) => row.model)).toEqual(["eleven-v3", "gpt-a", "gpt-b", "gpt-long", "gpt-realtime-whisper", "img-1"]);
    expect(rows[1]).toMatchObject({ input: 1, output: 4, unlistedSince: "2026-10-01", other: [] });
    expect(rows[0]!.output).toBeNull();
  });

  it("words prices per minute, hour and image with their unit", () => {
    const rows = priceRows(PRICES.prices);
    expect(rows[4]!.other).toEqual(["$0.017 / minute"]);
    expect(rows[5]!.other).toEqual(["$1.5 / hour", "$0.04 / image"]);
  });
});

describe("PricesPage", () => {
  it("shows a model's long-context rates and where they start, next to its base rates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PRICES))));
    renderAuthenticated(<PricesPage />);
    expect(await screen.findByText("gpt-long")).toBeTruthy();
    expect(screen.getByText("$8 base")).toBeTruthy();
    expect(screen.getByText("$16 above 272,000 input tokens")).toBeTruthy();
    expect(screen.getByText("$60 above 272,000 input tokens")).toBeTruthy();
  });

  it("shows each model's rates and notes, and filters them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PRICES))));
    renderAuthenticated(<PricesPage />);
    expect(await screen.findByText("gpt-b")).toBeTruthy();
    expect(screen.getByText("Retires 2027-01-06")).toBeTruthy();
    expect(screen.getByText("$0.017 / minute")).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/filter models/i), "eleven");
    expect(screen.queryByText("gpt-b")).toBeNull();
    expect(screen.getByText("eleven-v3")).toBeTruthy();
  });
});
