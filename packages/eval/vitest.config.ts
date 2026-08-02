import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    // Since the big data tables load in the background, an import no longer
    // guarantees readiness; the setup file waits for them once (ensure.ts)
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
