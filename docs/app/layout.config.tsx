import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { BrandMark } from "@/components/brand-mark";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="brand">
        <span>App</span>
        <BrandMark />
        <span>Gateway</span>
      </span>
    ),
  },
};
