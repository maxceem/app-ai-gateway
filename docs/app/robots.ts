import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/*.txt$", "/v1/", "/proxy/", "/auth/", "/dev/", "/secure/", "/me$", "/&"],
      },
    ],
    sitemap: new URL("sitemap.xml", siteUrl).toString(),
    host: siteUrl.host,
  };
}
