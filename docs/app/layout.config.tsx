import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Cable } from "lucide-react";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="brand-lockup">
        <span className="brand-mark"><Cable size={16} strokeWidth={2.2} /></span>
        <span>App AI Gateway</span>
      </span>
    ),
  },
  links: [
    { text: "API Reference", url: "/docs/api" },
    { text: "GitHub", url: "https://github.com/maxceem/app-ai-gateway", external: true },
  ],
};
