import { existsSync, readFileSync } from "fs";
import type { ReferenceCorpus } from "@gladlog/analysis";

/** 形状粗验:只认「有 cells 数组 + wowPatchVersion 字符串」的 JSON 为可用语料。 */
function isValidCorpusShape(x: unknown): x is ReferenceCorpus {
  if (!x || typeof x !== "object") return false;
  const c = x as Partial<ReferenceCorpus>;
  return Array.isArray(c.cells) && typeof c.wowPatchVersion === "string";
}

export interface CorpusLoadedInfo {
  path: string;
  wowPatchVersion: string;
  builtAt: string;
}

/**
 * 按 resolvePaths() 给出的优先级顺序尝试加载语料:文件存在 + JSON 解析成功 +
 * 形状粗验通过 → 取用并停;单个候选失败(缺文件/坏 JSON/形状不对)则继续下一个,
 * 全部失败 → null。首次解析成功后缓存,resolvePaths 只调用一次。
 *
 * corpusLoader 本身保持纯净(不依赖 electron/electron-log);「加载的是哪个
 * 路径」通过可选的 onLoaded 回调暴露,由调用方(main/index.ts)决定如何记日志。
 */
export function loadBundledCorpus(
  resolvePaths: () => string[],
  onLoaded?: (info: CorpusLoadedInfo) => void,
): () => ReferenceCorpus | null {
  let cached: ReferenceCorpus | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    cached = null;
    for (const p of resolvePaths()) {
      try {
        if (!existsSync(p)) continue;
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
        if (!isValidCorpusShape(parsed)) continue;
        cached = parsed;
        onLoaded?.({
          path: p,
          wowPatchVersion: parsed.wowPatchVersion,
          builtAt: parsed.builtAt,
        });
        break;
      } catch {
        continue;
      }
    }
    return cached;
  };
}

export function gameBuildFromManifest(manifest: { build?: string }): string {
  return manifest.build ?? "0.0.0.0";
}
