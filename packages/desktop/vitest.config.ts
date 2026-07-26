import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // 大数据表后台加载后 import 不再保证就绪,setup 统一等到位(ensure.ts)
    setupFiles: ["./vitest.setup.ts"],
    // qa/ 是 Playwright 的地盘:*.spec.ts 由 playwright 跑,vitest 不许碰
    exclude: [...configDefaults.exclude, "qa/**"],
    // include 只认 src/**:out/(构建产物)、dev/(测试台)、scripts/ 不进分母,
    // 否则 9 万行 bundle 会把行覆盖从 ~80% 灌到 9%(2026-07-25 审计实锤)。
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts"],
    },
  },
});
