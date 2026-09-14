import { House, LayoutDashboard } from "lucide-react";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavTitle } from "@/components/nav-title";
import { externalUrls } from "@/lib/site";

export const baseOptions: BaseLayoutProps = {
  nav: {
    // Where the wordmark goes. NavTitle receives it as `href` and pairs it with
    // a "Docs" link back to this site's index.
    url: externalUrls.marketing,
    title: NavTitle,
  },
  // A reader who arrives here from a search result has no other route to the
  // product, and the logo alone is an invisible one. These sit above the page
  // tree, on every page. They open in the same tab: the console and the
  // marketing site are this product on neighbouring subdomains, so leaving for
  // them is navigation. Only the repository, which is genuinely somewhere
  // else, keeps fumadocs' default new tab.
  links: [
    { icon: <House />, text: "Home", url: externalUrls.marketing, external: false },
    { icon: <LayoutDashboard />, text: "Console", url: externalUrls.console, external: false },
  ],
  githubUrl: externalUrls.repo,
};
