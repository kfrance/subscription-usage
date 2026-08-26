import { defineConfig } from "vitest/config";

/**
 * Live tests call real vendor APIs with real credentials, so the default run
 * excludes them. The exclusion has to be conditional rather than absolute:
 * vitest applies `exclude` even when a filename is passed on the command line,
 * so an unconditional pattern makes `vitest run <that file>` report no tests and
 * fail against `passWithNoTests`. Run them with `npm run test:live`.
 */
const includeLive = process.env.SUBSCRIPTION_USAGE_LIVE_TESTS === "1";

export default defineConfig({
  cacheDir: ".vite-temp/vitest",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: includeLive
      ? ["**/node_modules/**"]
      : ["**/node_modules/**", "**/*.live.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
