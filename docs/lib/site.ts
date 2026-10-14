import type { Metadata } from "next";

const configured = process.env.DOCS_SITE_URL ?? "https://docs.appaigateway.com";

export const siteUrl = new URL(configured.endsWith("/") ? configured : `${configured}/`);

export function pageUrl(slugs: string[] = []): string {
  const path = slugs.length > 0 ? `${slugs.join("/")}/` : "";
  return new URL(path, siteUrl).toString();
}

/**
 * The rest of the product, which lives on neighbouring hosts rather than in
 * this build. Self-hosters build these docs too, so each one is an environment
 * variable with the hosted value as its default: a fork that points its docs
 * somewhere else sets them instead of patching this file. They are read here,
 * on the server, and travel to the header as plain props — which is why none of
 * them needs a `NEXT_PUBLIC_` twin.
 */
function host(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, "");
}

export const externalUrls = {
  marketing: host(process.env.DOCS_MARKETING_URL, "https://appaigateway.com"),
  console: host(process.env.DOCS_CONSOLE_URL, "https://console.appaigateway.com"),
  repo: host(process.env.DOCS_REPO_URL, "https://github.com/maxceem/app-ai-gateway"),
};

export const siteName = "App AI Gateway";

/**
 * The docs home's own title, kept within the 60 characters a search result
 * shows, and distinct from the marketing site's home title.
 */
export const homeTitle = "App AI Gateway documentation — guides and API reference";

/**
 * Link previews in chats and social posts read Open Graph and X card tags, not
 * the page's `<title>` and meta description, so every page repeats those here
 * with its canonical URL. Next.js replaces a parent's `openGraph` and
 * `twitter` objects rather than merging them, which is why each page gets the
 * whole set. The picture is the overview diagram the docs home already shows,
 * so a fork carries it too; its URL resolves against `siteUrl`.
 */
const shareImage = {
  url: "/overview.png",
  width: 1660,
  height: 736,
  alt: "Your iOS app calls App AI Gateway, which holds the provider keys, applies per-user limits, records usage and cost, and forwards the request to the provider.",
};

export function shareMetadata(page: { title: string; description?: string; url: string }): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: {
      type: "website",
      siteName,
      title: page.title,
      description: page.description,
      url: page.url,
      images: [shareImage],
    },
    twitter: {
      card: "summary_large_image",
      title: page.title,
      description: page.description,
      images: [shareImage],
    },
  };
}
