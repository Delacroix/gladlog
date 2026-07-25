import { defineConfig } from "vitest/config";
// 注意:parseBudget.test.ts 是性能预算测试,v8 coverage 插桩会拖慢解析导致必挂。
// 本地看覆盖率时用:npx vitest run --coverage --exclude test/parseBudget.test.ts
// 不要给 parser 上 coverage CI 门。
export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
