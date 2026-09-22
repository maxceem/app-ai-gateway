/**
 * Providers and the gateways they can be routed through: two lists of one
 * subject, and the seven dialogs between them.
 *
 * This file is only the routing. Each section and each dialog is a file of its
 * own beside it, `./shared` holds what several of them say the same way, and
 * the reasoning that is not about rendering anything — how a pricing form reads
 * and how a probe's answer is worded — lives in `@/lib/pricing-draft` and
 * `@/lib/provider-probe`.
 */

import { Navigate, useParams } from "react-router-dom";
import { GatewaysSection } from "./gateways-section";
import { ProvidersSection } from "./providers-section";
import { GATEWAYS_PATH } from "./shared";

/**
 * Re-exported for the one page that reaches into this one: the apps page's
 * first-run checklist opens the add-provider modal itself rather than sending
 * an operator here mid-task.
 */
export { AddProviderButton } from "./add-provider-dialog";

interface SectionEntry {
  slug: string;
  path: string;
  Component: () => React.ReactElement;
}

/**
 * They share a destination and split in the sidebar, so each renders as a page
 * in its own right and its table gets the full width.
 */
const SECTIONS: SectionEntry[] = [
  { slug: "providers", path: "/providers", Component: ProvidersSection },
  { slug: "gateways", path: GATEWAYS_PATH, Component: GatewaysSection },
];

const DEFAULT_SECTION = SECTIONS[0]!;

export function ProvidersPage() {
  const { section } = useParams();
  const active = section === undefined
    ? DEFAULT_SECTION
    : SECTIONS.find((entry) => entry.slug === section);

  // An unknown section is a stale or hand-typed link, not an error worth a screen.
  if (!active) return <Navigate to={DEFAULT_SECTION.path} replace />;

  return <active.Component />;
}
