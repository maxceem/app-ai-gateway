import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { OpenAPIPageClient } from "@/components/api-page";
import { openapi } from "@/lib/openapi";
import { homeTitle, pageUrl, shareMetadata, siteName } from "@/lib/site";
import { source } from "@/lib/source";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const preloaded = await openapi.preloadOpenAPIPage(page);
  const OpenAPIPage = (openapiProps: ComponentProps<typeof OpenAPIPageClient>) => (
    <OpenAPIPageClient {...openapiProps} {...preloaded} />
  );

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {/* An endpoint page's description is written for search results and
          repeats the method and path the page shows right below; its own
          prose comes from the OpenAPI description instead. */}
      {isEndpointPage(page.slugs) ? null : <DocsDescription>{page.data.description}</DocsDescription>}
      <DocsBody><MDX components={{ ...defaultMdxComponents, OpenAPIPage }} /></DocsBody>
    </DocsPage>
  );
}

/** A generated API reference page for one operation, as opposed to `/api/` itself. */
function isEndpointPage(slugs: string[]): boolean {
  return slugs[0] === "api" && slugs.length > 1;
}

/**
 * Search results cut titles at about 60 characters. An endpoint page's title
 * is its operation's summary, and the same words can name a guide ("Create an
 * application"), so it says it is the API when that fits: the longest suffix
 * that keeps the title within the limit, or none.
 */
const TITLE_LIMIT = 60;
function endpointTitle(summary: string): string {
  const candidates = [`${summary} — ${siteName} API`, `${summary} — API`];
  return candidates.find((title) => title.length <= TITLE_LIMIT) ?? summary;
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  const slugs = params.slug ?? [];
  // The home page has its own title; endpoint pages name the API instead of
  // the site; every other page reads "<title> — App AI Gateway", like the
  // layout's template. It is spelled out here, rather than left to that
  // template, so link previews carry exactly the title search results show.
  const title =
    slugs.length === 0
      ? homeTitle
      : isEndpointPage(slugs)
        ? endpointTitle(page.data.title)
        : `${page.data.title} — ${siteName}`;
  const description = page.data.description;
  const url = pageUrl(slugs);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    ...shareMetadata({ title, description, url }),
  };
}
