import { defineConfig } from "vitest/config";
// NOTE: parseBudget.test.ts is a performance-budget test, and v8 coverage
// instrumentation slows parsing enough to make it fail every time.
// To look at coverage locally, use:
//   npx vitest run --coverage --exclude test/parseBudget.test.ts
// Do not put a coverage CI gate on parser.
export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
