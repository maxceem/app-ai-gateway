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

/** Width ÷ height of the shield. */
const ASPECT = 0.82;
/** "AI" height as a fraction of the shield's height. */
const LETTER_SIZE = 0.46;
/**
 * Offset of the letters from the centre. Negative because a shield tapers to a
 * point: its optical centre sits above its geometric one, so truly centred
 * letters look low.
 */
const LETTER_Y = -0.06;
/** How far the mark drops against the wordmark's baseline, as a ratio too. */
const TEXT_OFFSET_Y = 0.04;

export function BrandMark({ size = 22 }: { size?: number }) {
  const box: CSSProperties = {
    width: size * ASPECT,
    height: size,
    // A transform, not a margin, so the mark shifts visually against the
    // wordmark without disturbing the line box.
    transform: `translateY(${size * TEXT_OFFSET_Y}px)`,
  };

  const letters: CSSProperties = {
    fontSize: size * LETTER_SIZE,
    transform: `translateY(${size * LETTER_Y}px)`,
  };

  return (
    <span className="grid flex-none place-items-center" style={box}>
      <svg
        className="col-start-1 row-start-1 block size-full fill-(--brand-mark)"
        viewBox="0 0 82 100"
        aria-hidden="true"
        focusable="false"
      >
        <path d={SHIELD_PATH} />
      </svg>
      {/* Real text rather than an SVG <text> node, so it inherits the app's
          font stack and smoothing, and the wordmark still reads as
          "App AI Gateway" to a screen reader. Only the shield is hidden. */}
      <span
        className="col-start-1 row-start-1 font-bold leading-none tracking-[0.01em] text-white"
        style={letters}
      >
        AI
      </span>
    </span>
  );
}
