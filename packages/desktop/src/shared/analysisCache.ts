import { join } from "path";

import { PROMPT_VERSION } from "./promptVersion";

/** 分析缓存的落盘信封。主进程写、主进程读、E2E 播种,三处共用同一形状。 */
export interface AnalysisCacheDoc<T> {
  schemaVersion: 1;
  promptVersion: number;
  language: string;
  createdAt: number;
  result: T;
}

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
