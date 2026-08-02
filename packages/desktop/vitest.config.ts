import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Now that the large data tables load in the background, an import no longer
    // guarantees readiness — the setup file waits for them (ensure.ts)
    setupFiles: ["./vitest.setup.ts"],
    // qa/ is Playwright's territory: *.spec.ts is run by playwright, vitest must
    // not touch it
    exclude: [...configDefaults.exclude, "qa/**"],
    // include only src/**: out/ (build output), dev/ (the test bed) and scripts/
    // stay out of the denominator, or a 90k-line bundle drags line coverage from
    // ~80% down to 9% (measured in the 2026-07-25 audit).
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
