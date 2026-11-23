import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

/**
 * Chooses an option of a select by keyboard, as a keyboard user does, and
 * waits until the select shows it. Picking with the pointer leaves the
 * select's own pointer timers running after the click, which React then
 * reports as updates outside `act`.
 */
export async function chooseOption(select: string | HTMLElement, option: string) {
  const trigger = typeof select === "string" ? screen.getByRole("combobox", { name: select }) : select;
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  (await screen.findByRole("option", { name: option })).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(within(trigger).getByText(option)).toBeTruthy());
}
