import type { MetadataRoute } from "next";
import { pageUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: pageUrl(page.slugs),
    changeFrequency: "weekly",
    priority: page.slugs.length === 0 ? 1 : 0.7,
  }));
}
