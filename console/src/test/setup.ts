import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// `testTimeout` in the Vitest config sizes the whole test; this sizes one
// `findBy*`/`waitFor` inside it, and Testing Library defaults it to one second
// independently. That second is what the render-heavy suites actually run out
// of when files contend for the CPU — the test is nowhere near its own 20s
// budget, but a query waiting on two stubbed fetches and a react-query render
// gives up first. Same reasoning as the config comment, same generous sizing:
// long enough that only a genuinely stuck query reaches it.
configure({ asyncUtilTimeout: 5_000 });

// Radix primitives probe these; jsdom implements neither.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Radix Select drives its listbox through the Pointer Capture API, which jsdom
// does not implement at all.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

// Radix's positioning primitives (tooltip, select, dropdown) measure with these.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!globalThis.DOMRect) {
  globalThis.DOMRect = class {
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
    readonly top = 0;
    readonly left = 0;
    readonly right = 0;
    readonly bottom = 0;
    static fromRect(rect?: DOMRectInit) {
      return new DOMRect(rect?.x, rect?.y, rect?.width, rect?.height);
    }
    toJSON() {
      return this;
    }
  } as unknown as typeof DOMRect;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
