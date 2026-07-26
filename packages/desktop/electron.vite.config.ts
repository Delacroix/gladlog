import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "path";

// 大 JSON 走 JSON.parse 而不是对象字面量。spellNames.json 有 41 万个键,
// 编译成 JS 对象字面量要 V8 当**源码**解析,实测阻塞首屏 ~22s;同样的数据
// JSON.parse 只要 42ms。Vite 5 的默认值是 false,三个构建目标都得显式打开
// —— main/renderer 都会经 analysis 包吃到这份数据。
const json = { stringify: true } as const;

export default defineConfig({
  main: {
    json,
    plugins: [externalizeDepsPlugin({ exclude: ["@gladlog/parser"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          worker: resolve(__dirname, "src/worker/index.ts"),
          // 自愈 worker(worker_threads 按文件路径拉起,doc 字节直传后
          // main 不再 parse doc,旧肥档瘦身全在这里)
          slimWorker: resolve(__dirname, "src/main/slimWorker.ts"),
        },
      },
    },
  },
  preload: {
    json,
    // parser 同 main:必须打进包(preload 经 shared/slimDoc 吃到 slim 谓词;
    // 外部化会在打包产物里 require 不到 workspace 包)
    plugins: [externalizeDepsPlugin({ exclude: ["@gladlog/parser"] })],
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    json,
    plugins: [react()],
    root: "src/renderer",
    // electron-vite 对 renderer 的默认值是 minify:false(为 main/preload 调试
    // 设计的,renderer 跟着吃了)——生产 bundle 3.6MB 未压缩、CSS 也阻塞渲染;
    // 而 firstPaint 预算跑的是 dev/vite 构建(默认 esbuild 压缩),口径必须对齐。
    build: { minify: "esbuild" },
    // 把 shell 的 VITE_FIXTURE_MODE 显式注入 renderer(否则 electron-vite 不暴露它,
    // fixture 分支会被当死代码消掉)。VITE_FIXTURE_MODE=1 npm run dev 即免真数据预览。
    define: {
      "import.meta.env.VITE_FIXTURE_MODE": JSON.stringify(
        process.env.VITE_FIXTURE_MODE ?? "",
      ),
    },
  },
});
