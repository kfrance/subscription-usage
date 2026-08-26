import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vite-temp/vitest",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live tests call real vendor APIs with real credentials. Run them with
    // `npx vitest run --mode live tests/**/*.live.test.ts` when checking that a
    // vendor's payload still matches what the providers expect.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
