import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";

/** An outside reference inside a hint: opens in a new tab and says so. */
export function ExternalHint({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-0.5 underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}
