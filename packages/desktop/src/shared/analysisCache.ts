import { join } from "path";

import { PROMPT_VERSION } from "./promptVersion";
import type { AnalysisCacheDoc } from "./analysisSlots";

/**
 * renderer 禁止 import 本文件——顶部 `import { join } from "path"` 是
 * Node 内置模块,electron-vite 的 renderer 构建走浏览器目标,Rollup 打包
 * 时会把整个模块(连同 `path`)拖进浏览器 bundle,产物态报
 * `"join" is not exported by "__vite-browser-external"`(本地 vitest/tsc
 * 都测不出来,只有 `electron-vite build` 会炸——presubmit 抓到过一次,
 * 起因是 slotLabel.ts 曾经从这里 import `splitSlotKey`)。
 *
 * 纯槽逻辑(不碰 fs/path,main/renderer 都能安全 import)已经拆到
 * `./analysisSlots.ts`——下面 `export *` 只是给 main 侧既有 import 路径
 * 做向后兼容,renderer 新代码必须直接从 `./analysisSlots` import,不要
 * 从本文件 import 任何东西(哪怕看起来是纯函数)。
 */
export * from "./analysisSlots";

/**
 * 分析缓存文件路径。谓词单源 —— 文件名散在写侧、读侧、播种侧三处的话,
 * 改名时漏掉一处的表现是「缓存静默未命中」:没有报错,只是面板停在空闲态。
 */
export function analysisCachePath(
  matchesDir: string,
  matchId: string,
  lang: string,
): string {
  return join(matchesDir, matchId, `analysis-v2.${lang}.json`);
}

/**
 * 按上面的信封包装结果。`createdAt` 由调用方注入,便于测试固定时间。
 * @deprecated v1 单结果信封。写侧已切到 `upsertSlot`(v2 分槽);仅旧迁移路径与
 * 本文件内部引用保留,新代码不要新增调用点。
 */
export function analysisCacheDoc<T>(
  lang: string,
  result: T,
  createdAt: number = Date.now(),
): AnalysisCacheDoc<T> {
  return {
    schemaVersion: 1,
    promptVersion: PROMPT_VERSION,
    language: lang,
    createdAt,
    result,
  };
}
