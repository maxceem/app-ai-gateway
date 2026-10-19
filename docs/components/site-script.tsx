import Script from "next/script";

/**
 * Deployment-specific JavaScript for the hosted documentation, such as an
 * analytics tag, read when the site is built and unset by default. Self-hosters
 * build these docs too, and a build that was not given a script renders nothing
 * and requests nothing, so a fork never reports to somebody else's account.
 *
 * What the script does belongs to the deployment rather than to this
 * repository, so it is configuration and not source. Whoever sets it is
 * responsible for it keeping the promises of their own privacy policy,
 * including honouring the browser's Do Not Track setting.
 */
const siteScript = process.env.DOCS_SITE_SCRIPT?.trim();

// Parsed, never run, so a script that would only throw a syntax error in every
// visitor's browser fails the build instead.
if (siteScript) {
  try {
    new Function(siteScript);
  } catch (error) {
    throw new Error(`DOCS_SITE_SCRIPT is not valid JavaScript: ${(error as Error).message}`);
  }
}

export function SiteScript() {
  if (!siteScript) return null;
  return (
    <Script id="site-script" strategy="afterInteractive">
      {siteScript}
    </Script>
  );
}
