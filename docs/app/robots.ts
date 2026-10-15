import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // The last entry is the IndexNow key file (see docs/scripts/indexnow.mjs).
        allow: ["/", "/llms.txt", "/llms-full.txt", "/agents.md", "/openapi.json", "/fdf1d05a878c0a7e44d6b7ff422ba3d1.txt"],
        disallow: ["/*.txt$", "/v1/", "/proxy/", "/auth/", "/dev/", "/secure/", "/me$", "/&"],
      },
    ],
    sitemap: new URL("sitemap.xml", siteUrl).toString(),
    host: siteUrl.host,
  };
}
