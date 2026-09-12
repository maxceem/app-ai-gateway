import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Plain JS, and the same helper the deploy path uses to merge a profile
// overlay over the tracked config. It ships no declarations.
// @ts-expect-error - untyped .mjs
import { resolveWranglerConfig } from "../scripts/wrangler-config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * The Wrangler configuration the dev Worker runs on.
 *
 * The tracked `wrangler.jsonc` is the complete self-hosted deployment and
 * declares no optional services, which is right for it and for the Deploy
 * button. A developer running against one — a billing Worker in another
 * `wrangler dev` — names a deployment profile in a gitignored `.env` at the
 * repository root (`APP_AI_GATEWAY_PROFILE=local`), and the same overlay
 * mechanism the deploy path uses supplies the merged config. Absent that, this
 * resolves to exactly the file it always did.
 */
function workerConfigPathFor(mode: string): string {
  const profile = loadEnv(mode, repoRoot, "APP_AI_GATEWAY_").APP_AI_GATEWAY_PROFILE;
  return profile
    ? resolveWranglerConfig(profile).configPath
    : path.resolve(repoRoot, "wrangler.jsonc");
}

export default defineConfig(({ command, mode, isPreview }) => {
  // Development is a single Vite server: the Cloudflare plugin runs the API
  // Worker in workerd and Vite serves the console with HMR on the same origin.
  // Production builds stay client-only because Wrangler deploys the Worker and
  // the generated console/dist assets using the repository's existing flow.
  const cloudflareDev = command === "serve" && !isPreview && mode !== "test";

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(cloudflareDev
        ? [cloudflare({
          configPath: workerConfigPathFor(mode),
          inspectorPort: false,
          // The same local D1, KV and Durable Object state `wrangler dev` uses.
          // The plugin would otherwise persist beside this config — the Vite
          // root is `console/` — giving the repository two local databases that
          // look alike and drift apart: `pnpm run db:migrate:local` reaches only
          // the one at the repository root, so the other stays on whatever
          // schema it was last given, and a migration appears to have worked
          // while the dev server keeps reading the old tables.
          persistState: { path: path.resolve(import.meta.dirname, "../.wrangler/state") },
        })]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        // The shared capability matrix, one directory up and outside this package.
        // It imports nothing, so bundling it costs the tables themselves and
        // pulls no server dependency into the browser build.
        "@shared": path.resolve(import.meta.dirname, "../src/shared"),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
    test: {
      // Auth screens and capability gating are only meaningful when rendered, so
      // the suite runs in a DOM. happy-dom rather than jsdom: the suite is
      // dominated by rendering, and on this one it measured about twice as
      // fast — 47.6s to 24.0s across every file. It implements less, which the
      // polyfills below already anticipated; the one gap that mattered was ARIA
      // property reflection (`el.ariaDisabled`), so the assertions that used it
      // read the attribute the component actually sets instead.
      environment: "happy-dom",
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
      // Building the window is what this suite actually spends its time on —
      // far more than running the tests inside it — so both knobs here aim at
      // that cost rather than at the tests. Threads share one process per
      // worker instead of forking a new one per file, and `isolate: false`
      // reuses a worker's window and module registry across the files it runs,
      // which is what removes the bulk of it. Nothing here is order-dependent:
      // `restoreMocks` resets spies and the Testing Library `cleanup` in
      // `setup.ts` unmounts between tests, so a file starts on an empty DOM.
      // Verified by running the suite under `--sequence.shuffle`.
      pool: "threads",
      isolate: false,
      // The interaction tests are CPU-bound, not waiting on anything: rendering a
      // page and driving a modal through a simulated DOM costs real milliseconds
      // per keystroke, so the heaviest of them spend over a second of work even
      // with the machine to themselves. Run in parallel across every file that
      // work contends and the same test takes three to four times as long, which
      // put the slowest ones within a few hundred milliseconds of the 5s default
      // and made them fail on load rather than on merit. The timeout is here to
      // catch a test that has genuinely hung, so it is sized against that: 20s is
      // far more than the slowest test needs and still far less than forever.
      testTimeout: 20_000,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Assets are public; shipping ~6 MB of source maps on every deploy is not
      // worth it for a console whose source lives in this repo.
      sourcemap: false,
    },
  };
});
