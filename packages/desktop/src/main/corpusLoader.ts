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
    // resolvePaths() 本身抛出(路径解析失败,如 app.getPath 异常)= null——
    // 维持旧实现「解析失败=null」的契约,不让异常穿透给调用方(compare.ts
    // 对 loadCorpus() 无 try/catch,穿透会变成 unhandled rejection 而非
    // 优雅的 NO_CORPUS)。
    let paths: string[];
    try {
      paths = resolvePaths();
    } catch {
      return cached;
    }
    let loaded: CorpusLoadedInfo | null = null;
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue;
        const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
        if (!isValidCorpusShape(parsed)) continue;
        cached = parsed;
        loaded = {
          path: p,
          wowPatchVersion: parsed.wowPatchVersion,
          builtAt: parsed.builtAt,
        };
        break;
      } catch {
        continue;
      }
    }
    // onLoaded 挪到循环外:若它抛出,不能被误当「该候选失败」吞掉进而
    // fallthrough 到下一路径,丢弃已经解析成功的 corpus。
    if (loaded) onLoaded?.(loaded);
    return cached;
  };
}

export function gameBuildFromManifest(manifest: { build?: string }): string {
  return manifest.build ?? "0.0.0.0";
}
