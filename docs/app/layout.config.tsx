import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="brand">
        <span>App</span>
        <span className="brand-badge">AI</span>
        <span>Gateway</span>
      </span>
    ),
  },
  links: [
    { text: "API Reference", url: "/api" },
    { text: "GitHub", url: "https://github.com/maxceem/app-ai-gateway", external: true },
  ],
};
