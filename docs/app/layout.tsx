import type { Metadata } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { siteUrl } from "@/lib/site";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "App AI Gateway — Ship AI features without shipping provider keys.",
    template: "%s — App AI Gateway",
  },
  description:
    "An LLM gateway for iOS apps and server backends. Keep provider keys off the device, verify every request with Apple App Attest, and see usage, cost, and limits per user — hosted, or self-hosted on your own Cloudflare account.",
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
