import type { CSSProperties } from "react";

/**
 * The shield in the "App [AI] Gateway" wordmark, the same shape the marketing
 * site and the favicon use. Scale it; never stretch it — drawing it at another
 * aspect ratio is what makes one mark read as two.
 *
 * The ink fills the viewBox exactly (82x100), so the box it is drawn into is
 * its real extent and no padding has to be compensated for. Every proportion
 * below is a ratio of the rendered height, so a different `size` scales the
 * letters and the baseline nudge with it instead of drifting.
 *
 * public/favicon.svg carries a copy of the path because a static asset cannot
 * import from TypeScript — keep the two in step.
 */
const SHIELD_PATH = "M41 0 L82 12 L82 52 C82 71 69.7 90.3 41 100 C12.3 90.3 0 71 0 52 L0 12 Z";

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <span className="brandmark" style={{ "--brandmark-h": `${size}px` } as CSSProperties}>
      <svg className="brandmark-shield" viewBox="0 0 82 100" aria-hidden="true" focusable="false">
        <path d={SHIELD_PATH} />
      </svg>
      {/* Real text rather than an SVG <text> node, so it inherits the page's
          font stack and smoothing, and the wordmark still reads as
          "App AI Gateway" to a screen reader. Only the shield is hidden. */}
      <span className="brandmark-letters">AI</span>
    </span>
  );
}
