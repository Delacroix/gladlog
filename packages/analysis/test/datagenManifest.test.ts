import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

/**
 * 防腐测试:packages/analysis/src/data/ 下任何"生成物"都必须登记进
 * datagen-manifest.json 的 artifacts 里,否则 update-wow-data 工作流不知道
 * 该重新生成它 —— 漏登记不会报错,只会在新资料片后静默继续吐旧数据
 * (见本次修复前 offGcdGenerated.ts / drCategoriesGenerated.ts /
 * pvpTalentReplacesGenerated.ts / specIconsGenerated.ts / 观测集两处的漏登记)。
 *
 * "生成物"判据(实测三种标记不统一,缺一不可):
 *   1. 文件名含 "Generated"(多数 .ts/.json 生成物遵循这个命名约定)
 *   2. 文件头有生成标记注释("Generated at: ..." 或 "生成文件 —— 勿手改/勿手编")
 *   3. JSON 顶层有 "generatedAt" 字段(部分 .json 产物无 .ts 命名壳)
 *
 * 命中任一条即视为"生成物",要么出现在 manifest.artifacts,要么进下方
 * EXEMPT_GENERATED_ARTIFACTS 显式豁免清单并写明理由 —— 豁免必须是明写的
 * 决定,不能靠沉默漏登记蒙混过关。
 */

const DATA_DIR = path.resolve(__dirname, "../src/data");
const MANIFEST_PATH = path.join(DATA_DIR, "datagen-manifest.json");

// manifest 自身不是"产物",跳过。
const MANIFEST_FILENAME = "datagen-manifest.json";

/**
 * 命中判据、但**有意**不登记进 datagen-manifest.json 的产物。
 * 两条都是"语料/统计驱动"而非"WoW 版本驱动":生产者不在
 * scripts/datagen/ 也不在 packages/eval/scripts/,不受 update-wow-data
 * 工作流覆盖,由各自独立的手动流水线刷新。
 */
const EXEMPT_GENERATED_ARTIFACTS: Record<string, string> = {
  "benchmarks.json":
    "对局语料实证的玩家表现百分位基准,由 packages/analysis/scripts/collectBenchmarks.ts" +
    " 从本地对局日志聚合生成,与 WoW build/DB2 数据无关(不会因资料片更新而过期," +
    " 只会因版本平衡改动而过期,需要新版本已有对局样本后才能重新采集),不属于" +
    " update-wow-data 覆盖范围。",
  "archetypes/archetype_model_3v3.json":
    "对局原型聚类模型,由仓外聚类流水线产出(archetypeInjection.ts 顶部注释指向" +
    " cluster-eval-report.md,生成器未入本仓)。语料驱动,非 WoW 版本驱动,不属于" +
    " update-wow-data 覆盖范围。",
  "archetypes/archetype_model_solo_shuffle.json":
    "同 archetype_model_3v3.json。",
};

function listDataFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      out.push(...listDataFiles(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const HEADER_MARKER_RE = /Generated at:|生成文件.{0,6}(勿手改|勿手编)/;

/** 命中任一判据则返回判据说明,否则返回 null。 */
function detectGenerated(relPath: string): string | null {
  if (relPath === MANIFEST_FILENAME) return null;

  const base = path.basename(relPath);
  if (base.includes("Generated")) return "文件名含 Generated";

  const text = readFileSync(path.join(DATA_DIR, relPath), "utf-8");
  if (HEADER_MARKER_RE.test(text.slice(0, 2000))) {
    return "文件头有生成标记注释";
  }

  if (base.endsWith(".json")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "generatedAt" in (parsed as Record<string, unknown>)
      ) {
        return "JSON 顶层含 generatedAt 字段";
      }
    } catch {
      /* 非 JSON 或解析失败,不算命中 */
    }
  }
  return null;
}

/**
 * manifest 的某条 key 是否覆盖了这个生成物。多数产物 key 与文件名一致;
 * 少数 .json 数据文件没有独立 key,由同名 .ts 壳的 entry 一并覆盖
 * (如 spellEffectGenerated.json 的规模记在 "spellEffectGenerated.ts" 下,
 * 见 writeManifest.ts 注释)——同 stem 换扩展名(.json<->.ts)也算覆盖。
 */
function isCoveredByManifest(
  relPath: string,
  artifactKeys: Set<string>,
): boolean {
  const base = path.basename(relPath);
  if (artifactKeys.has(base) || artifactKeys.has(relPath)) return true;

  const swapped = base.endsWith(".json")
    ? base.replace(/\.json$/, ".ts")
    : base.endsWith(".ts")
      ? base.replace(/\.ts$/, ".json")
      : undefined;
  return swapped ? artifactKeys.has(swapped) : false;
}

describe("datagen-manifest.json 生成物覆盖", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as {
    artifacts: Record<string, unknown>;
  };
  const artifactKeys = new Set(Object.keys(manifest.artifacts));
  const files = listDataFiles(DATA_DIR);

  it("每个被判据命中的生成物,要么登记进 manifest.artifacts,要么在显式豁免清单里", () => {
    const unregistered: string[] = [];
    for (const relPath of files) {
      const reason = detectGenerated(relPath);
      if (!reason) continue;
      if (relPath in EXEMPT_GENERATED_ARTIFACTS) continue;
      if (isCoveredByManifest(relPath, artifactKeys)) continue;
      unregistered.push(`${relPath}(判据: ${reason})`);
    }
    expect(unregistered).toEqual([]);
  });

  it("豁免清单条目本身存在、且确实会被判据命中(防止豁免清单腐烂成沉默遗漏)", () => {
    for (const relPath of Object.keys(EXEMPT_GENERATED_ARTIFACTS)) {
      expect(() => statSync(path.join(DATA_DIR, relPath))).not.toThrow();
      expect(detectGenerated(relPath)).not.toBeNull();
    }
  });

  it("豁免清单条目理由非空,且不该被 manifest 直接命中(否则该转正登记而非豁免)", () => {
    for (const [relPath, reason] of Object.entries(
      EXEMPT_GENERATED_ARTIFACTS,
    )) {
      expect(reason.length).toBeGreaterThan(0);
      expect(isCoveredByManifest(relPath, artifactKeys)).toBe(false);
    }
  });
});
