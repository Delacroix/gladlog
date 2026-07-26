import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: true,
    // 大数据表后台加载后 import 不再保证就绪,setup 统一等到位(ensure.ts)
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
