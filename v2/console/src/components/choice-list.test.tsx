import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceList, type Choice } from "./choice-list";

const CHOICES: Choice<"a" | "b" | "c">[] = [
  { value: "a", label: "Alpha", description: "First" },
  { value: "b", label: "Beta", description: "Second" },
  { value: "c", label: "Gamma", description: "Third" },
];

function Harness({ initial }: { initial: "a" | "b" | "c" | null }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button">Before</button>
      <ChoiceList label="Letter" choices={CHOICES} value={value} onChange={setValue} />
      <button type="button">After</button>
    </>
  );
}

const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("ChoiceList", () => {
  it("is one tab stop, on the chosen answer", async () => {
    render(<Harness initial="b" />);
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("Before");
    await userEvent.tab();
    expect(document.activeElement).toBe(radio(/beta/i));
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe("After");
  });

  it("puts the tab stop on the first answer when none is chosen", async () => {
    render(<Harness initial={null} />);
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(radio(/alpha/i));
    expect(radio(/alpha/i).getAttribute("aria-checked")).toBe("false");
  });

  it("moves focus and the choice with the arrow keys, wrapping, and Home and End", async () => {
    render(<Harness initial="a" />);
    await userEvent.click(radio(/alpha/i));

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radio(/beta/i));
    expect(radio(/beta/i).getAttribute("aria-checked")).toBe("true");

    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toBe(radio(/alpha/i));
    expect(radio(/alpha/i).getAttribute("aria-checked")).toBe("true");

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(radio(/gamma/i));
    expect(radio(/gamma/i).getAttribute("aria-checked")).toBe("true");

    await userEvent.keyboard("{Home}");
    expect(radio(/alpha/i).getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(radio(/gamma/i));
    expect(radio(/gamma/i).getAttribute("aria-checked")).toBe("true");
    // Exactly one answer is ever chosen, and it is the one tab stop.
    expect(screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
  });
});
