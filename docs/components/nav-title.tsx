"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { BrandMark } from "@/components/brand-mark";

/**
 * The header lockup, split into two links.
 *
 * The docs sit on their own subdomain, so a single logo link has to pick one
 * of two homes and strands the other: point it at the marketing site and there
 * is no way back to the docs index, point it here and a reader who wants the
 * product has no exit. Splitting the lockup settles it the way most docs
 * subdomains do — the wordmark leaves for the marketing site, the "Docs"
 * suffix returns to this site's index.
 *
 * Fumadocs calls this as a plain function rather than rendering it as an
 * element, so it must not use hooks. It hands over `nav.url` as `href`, which
 * is how the marketing host reaches this client component without an env var
 * of its own. The wordmark is a plain `<a>` on purpose: fumadocs' own `Link`
 * would read the absolute URL as external and open a new tab, and a
 * neighbouring subdomain of the same product is navigation, not a reference.
 */
export function NavTitle({ href, className, ...props }: ComponentProps<"a">) {
  return (
    <span className={className}>
      <a href={href} className="brand" {...props}>
        <span>App</span>
        <BrandMark />
        <span>Gateway</span>
      </a>
      <Link href="/" className="nav-docs">
        Docs
      </Link>
    </span>
  );
}
