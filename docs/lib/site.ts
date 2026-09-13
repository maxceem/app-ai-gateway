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
