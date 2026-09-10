const configured = process.env.DOCS_SITE_URL ?? "https://docs.appaigateway.com";

export const siteUrl = new URL(configured.endsWith("/") ? configured : `${configured}/`);

export function pageUrl(slugs: string[] = []): string {
  const path = slugs.length > 0 ? `${slugs.join("/")}/` : "";
  return new URL(path, siteUrl).toString();
}
