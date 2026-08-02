import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    // Once the big data tables load in the background, an import no longer
    // guarantees readiness — the setup file waits for them (ensure.ts)
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
