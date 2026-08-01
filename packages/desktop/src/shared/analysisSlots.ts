import { PROMPT_VERSION } from "./promptVersion";

/**
 * 纯槽逻辑(多模型对比):类型 + toSlottedDoc/resolveActiveSlot/upsertSlot/
 * slotKeyOf/splitSlotKey。刻意与 `analysisCache.ts` 拆开——本文件零 `fs`/`path`
 * 依赖,main 与 renderer 都能安全 import。
 *
 * 血的教训(最终评审 presubmit 抓到):renderer 的 `slotLabel.ts` 曾经直接
 * import `analysisCache.ts` 里的 `splitSlotKey`,而那个文件顶部有
 * `import { join } from "path"`(供 `analysisCachePath` 用)——Node 内置模块,
 * electron-vite 的 renderer 构建走浏览器目标,Rollup 打包时整个模块连同
 * `path` 一起被拖进浏览器 bundle,产物态直接报
 * `"join" is not exported by "__vite-browser-external"`,本地 vitest/tsc
 * 都测不出来(它们不做浏览器打包这一步),只有 `electron-vite build` 会炸。
 * 所以:任何要给 renderer 用的纯函数,必须待在这个零 Node 依赖的文件里,
 * 不能跟 `analysisCachePath` 这类文件系统谓词共享一个模块。
 */

/** 分析缓存的落盘信封。主进程写、主进程读、E2E 播种,三处共用同一形状。 */
export interface AnalysisCacheDoc<T> {
  schemaVersion: 1;
  promptVersion: number;
  language: string;
  createdAt: number;
  result: T;
}

/** 一次模型分析结果的落盘槽位:哪版 prompt、何时生成、结果本体。 */
export interface AnalysisSlot<T> {
  promptVersion: number;
  createdAt: number;
  result: T;
}

/**
 * 分析缓存的 v2 信封:同一场对局按 `slotKeyOf(backend, model)` 分槽存多个模型
 * 的结果,`lastSlotKey` 指向当前应展示/消费的那一槽。
 */
export interface AnalysisCacheDocV2<T> {
  schemaVersion: 2;
  language: string;
  slots: Record<string, AnalysisSlot<T>>;
  lastSlotKey: string;
}

/**
 * 读侧统一入口:v2 原样通过;v1/无版本的旧单结果懒包装成单槽(不落盘,纯内存
 * 转换)。垃圾输入(缺 slots/缺 result)返回 null。null 入 null 出。
 */
export function toSlottedDoc<T>(
  raw: unknown,
  legacySlotKey: string,
): AnalysisCacheDocV2<T> | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion === 2 && obj.slots && obj.lastSlotKey) {
    return raw as AnalysisCacheDocV2<T>;
  }
  if ("result" in obj) {
    const legacy = obj as Partial<AnalysisCacheDoc<T>>;
    return {
      schemaVersion: 2,
      language: typeof legacy.language === "string" ? legacy.language : "",
      slots: {
        [legacySlotKey]: {
          promptVersion: legacy.promptVersion ?? 0,
          createdAt: legacy.createdAt ?? 0,
          result: legacy.result as T,
        },
      },
      lastSlotKey: legacySlotKey,
    };
  }
  return null;
}

/** 消费口径单源:`lastSlotKey` 指向的槽;槽缺失(文件损坏等)返回 null。 */
export function resolveActiveSlot<T>(
  doc: AnalysisCacheDocV2<T> | null,
): AnalysisSlot<T> | null {
  if (!doc) return null;
  return doc.slots[doc.lastSlotKey] ?? null;
}

/** 写侧:在(可能为 null 的)现有 doc 上 upsert 一个槽并置 `lastSlotKey`。 */
export function upsertSlot<T>(
  existing: AnalysisCacheDocV2<T> | null,
  lang: string,
  slotKey: string,
  result: T,
  createdAt: number = Date.now(),
): AnalysisCacheDocV2<T> {
  return {
    schemaVersion: 2,
    language: lang,
    slots: {
      ...(existing?.slots ?? {}),
      [slotKey]: { promptVersion: PROMPT_VERSION, createdAt, result },
    },
    lastSlotKey: slotKey,
  };
}

/** 槽键单源:同一处拼接,别处不得重复拼字符串。 */
export function slotKeyOf(backend: string, model: string): string {
  return `${backend}:${model}`;
}

/**
 * 槽键单源的逆操作:拆出 backend/model。与 `slotKeyOf` 拼接对称放同一处
 * ——deepenInner(main/analysis.ts)与 renderer 的 slotLabel 都要从槽键
 * 反推 backend/model,此前各自手写 `indexOf(":")` 是两份重复谓词,容易在
 * model 本身含冒号(理论上不会,但没有类型保证)时裂开成不同的拆法。
 *
 * 只按**第一个**冒号切:model 段允许包含冒号,backend 段不允许。
 * 格式不对(缺冒号,如空字符串或没有 ":")返回 null——调用方据此走回退
 * 分支,不猜一个可能是错的 backend。
 */
export function splitSlotKey(
  key: string,
): { backend: string; model: string } | null {
  const idx = key.indexOf(":");
  if (idx === -1) return null;
  return { backend: key.slice(0, idx), model: key.slice(idx + 1) };
}
