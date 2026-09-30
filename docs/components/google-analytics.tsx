import Script from "next/script";

/**
 * Google Analytics for the hosted documentation, read when the site is built
 * and unset by default. Self-hosters build these docs too, and a build that was
 * not given a measurement ID renders nothing and requests nothing, so a fork
 * never reports to somebody else's property.
 *
 * The browser's Do Not Track setting is checked before the tag is requested,
 * because the hosted privacy policy promises that it stops all collection.
 * Google signals and ad personalisation are off: this is measurement for SEO
 * tooling, which reads organic landing pages from the property, and nothing
 * more.
 */
const measurementId = process.env.DOCS_GA_MEASUREMENT_ID;

// The ID is written into an inline script, so it must be exactly an ID. A typo
// fails the build instead of shipping a tag that silently measures nothing.
if (measurementId && !/^G-[A-Z0-9]+$/.test(measurementId)) {
  throw new Error(`DOCS_GA_MEASUREMENT_ID must look like G-XXXXXXXXXX, got "${measurementId}".`);
}

// Any value of `debug_mode`, false included, turns it on, so a production build
// sends none. `next dev` traffic lands in DebugView rather than in reports.
const debug = process.env.NODE_ENV === "production" ? "" : "debug_mode: true,";

export function GoogleAnalytics() {
  if (!measurementId) return null;
  return (
    <Script id="google-analytics" strategy="afterInteractive">
      {`(function (id) {
  var dnt = [navigator.doNotTrack, window.doNotTrack];
  if (dnt.indexOf("1") !== -1 || dnt.indexOf("yes") !== -1) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_expires: ${180 * 24 * 60 * 60},
    ${debug}
  });
  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + id;
  document.head.appendChild(script);
})("${measurementId}");`}
    </Script>
  );
}
