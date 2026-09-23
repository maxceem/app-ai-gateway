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

// Node 26 exposes an undefined experimental web-storage accessor unless a
// persistence file is configured. It shadows happy-dom's working storage on
// globalThis, so restore the DOM implementation used by the browser tests.
if (typeof globalThis.localStorage === "undefined") {
  const storage = (): Storage => {
    const values = new Map<string, string>();
    return {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => { values.delete(key); },
      setItem: (key, value) => { values.set(key, String(value)); },
    };
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage(),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage(),
  });
}

// Radix primitives probe these; the test DOM implements neither.
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

// Radix Select drives its listbox through the Pointer Capture API, which the
// test DOM does not implement at all.
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

// The console's tests stub every request they make, so a real call leaving the
// suite is a bug in a test — the relative URL the console asks for resolves
// against the test DOM's own location and reaches a port nobody is serving,
// which surfaces only as a connection error printed beside an otherwise green
// run. Rejecting it here names the request and fails the test that made it.
//
// A plain function rather than `vi.fn`: `restoreMocks` would strip a mock
// between tests, while a test that wants its own stub still spies on top of
// this one and is restored back down to it.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" || input instanceof URL
    ? String(input)
    : input.url;
  const method = init?.method
    ?? (typeof input === "object" && input !== null && "method" in input
      ? input.method
      : "GET");
  return Promise.reject(new Error(`Unstubbed network call in a test: ${method} ${url}`));
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
