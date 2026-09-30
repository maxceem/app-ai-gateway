import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where a page puts the action that creates its rows: beside the title, the
 * way the Providers, Gateways and Apps pages do.
 *
 * An app's sections are headed by the detail page, not by themselves, so a
 * section that has such an action hands it up through this slot rather than
 * drawing a second header of its own. `undefined` means no page offers a slot
 * — a section rendered on its own, as in a test — and the action is drawn in
 * place; `null` means the page has a slot that is not mounted yet, and the
 * action waits for it rather than flashing inline first.
 */
const PageActionSlot = createContext<HTMLElement | null | undefined>(undefined);

export const PageActionProvider = PageActionSlot.Provider;

export function PageAction({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionSlot);
  if (slot === undefined) return <>{children}</>;
  if (slot === null) return null;
  return createPortal(children, slot);
}
