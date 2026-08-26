import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vite-temp/vitest",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
