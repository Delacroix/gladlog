/**
 * familyBias.ts CLI — D1 同族偏差 2×2 双差分(子项目 D)三子命令:
 *
 *   npx tsx packages/eval/scripts/familyBias.ts --gen-responses --ab <abId>
 *   npx tsx packages/eval/scripts/familyBias.ts --judge-d --ab <abId>
 *   npx tsx packages/eval/scripts/familyBias.ts --stats --ab <abId>
 *
 * 三步顺序运行:先对 <abId>/prompts/ 逐个生成 DeepSeek 回复
 * (responses-d/,断点续跑),再(在盲池已由 blindPool.ts 构建之后)对
 * blind/items/ 逐件跑 DeepSeek 判官(blind/scores-d/,断点续跑),最后解盲
 * 算双差分统计(family-stats.json)。全部逻辑在 src/family/familyBias.ts /
 * deepseekDriver.ts,这里只做参数解析与 fs/网络 IO 编排。
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import fs from "fs-extra";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import {
  buildJudgeMessages,
  buildResponderMessages,
  callDeepseek,
  parseScoreObject,
} from "../src/family/deepseekDriver.js";
import {
  computeFamilyStats,
  extractStep3Rubric,
  renderFamilyStatsMarkdown,
} from "../src/family/familyBias.js";

// 仓库根目录:从本文件路径向上两级(packages/eval/scripts/ → 仓库根),不依赖
// 调用方的 cwd —— rubric 契约文件 docs/commands/eval-baseline.md 相对仓库根。
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

async function runGenResponses(abDirPath: string): Promise<void> {
  const promptsDir = path.join(abDirPath, "prompts");
  const outDir = path.join(abDirPath, "responses-d");
  await fs.ensureDir(outDir);
  const files = (await fs.readdir(promptsDir))
    .filter((f) => f.endsWith(".txt"))
    .sort();
  let generated = 0;
  let skipped = 0;
  for (const file of files) {
    const m = file.match(/^(\d+)/);
    if (!m) {
      console.warn(`  跳过无法解析 ordinal 的文件名:${file}`);
      continue;
    }
    const nnn = m[1].padStart(3, "0");
    const outPath = path.join(outDir, `${nnn}.txt`);
    if (await fs.pathExists(outPath)) {
      skipped++;
      continue;
    }
    const promptText = await fs.readFile(path.join(promptsDir, file), "utf8");
    const response = await callDeepseek(buildResponderMessages(promptText));
    await fs.writeFile(outPath, response, "utf8");
    generated++;
    console.log(`  ${nnn}: 生成回复(${response.length} chars)`);
  }
  console.log(
    `gen-responses: ${generated} 生成,${skipped} 已存在跳过,输出 ${outDir}`,
  );
}

async function runJudgeD(abDirPath: string): Promise<void> {
  const itemsDir = path.join(abDirPath, "blind", "items");
  const outDir = path.join(abDirPath, "blind", "scores-d");
  await fs.ensureDir(outDir);

  const rubricSrc = await fs.readFile(
    path.join(REPO_ROOT, "docs", "commands", "eval-baseline.md"),
    "utf8",
  );
  const rubric = extractStep3Rubric(rubricSrc);

  const blindIds = (await fs.readdir(itemsDir)).sort();
  let judged = 0;
  let skipped = 0;
  let failed = 0;
  for (const blindId of blindIds) {
    const outPath = path.join(outDir, `${blindId}.json`);
    if (await fs.pathExists(outPath)) {
      skipped++;
      continue;
    }
    const itemDir = path.join(itemsDir, blindId);
    const promptText = await fs.readFile(
      path.join(itemDir, "prompt.txt"),
      "utf8",
    );
    const responseText = await fs.readFile(
      path.join(itemDir, "response.txt"),
      "utf8",
    );
    const raw = await callDeepseek(
      buildJudgeMessages(rubric, promptText, responseText),
    );
    const parsed = parseScoreObject(raw) as Record<string, unknown> | null;
    if (!parsed) {
      console.error(
        `  ${blindId}: DeepSeek 判分未能解析为 JSON,跳过(可重跑续补)`,
      );
      failed++;
      continue;
    }
    const priorProvenance =
      typeof parsed.provenance === "object" && parsed.provenance !== null
        ? (parsed.provenance as Record<string, unknown>)
        : {};
    const score = {
      ...parsed,
      // matchId=blindId 是盲件占位约定(eval-ab.md)——盲件不带 MATCHID 头,
      // 真实 matchId 只在 mapping.json 里,判分文件绝不能猜/编。
      matchId: blindId,
      provenance: {
        ...priorProvenance,
        judgeModel: "deepseek-chat",
        judgedAt: new Date().toISOString(),
        promptSha256: createHash("sha256").update(promptText).digest("hex"),
        responseSha256: createHash("sha256").update(responseText).digest("hex"),
      },
    };
    await fs.writeJson(outPath, score, { spaces: 2 });
    judged++;
  }
  console.log(
    `judge-d: ${judged} 判分,${skipped} 已存在跳过,${failed} 解析失败,输出 ${outDir}`,
  );
}

async function runStats(abDirPath: string): Promise<void> {
  const report = await computeFamilyStats(abDirPath);
  const outPath = path.join(abDirPath, "family-stats.json");
  await fs.writeJson(outPath, report, { spaces: 2 });
  console.log(renderFamilyStatsMarkdown(report));
  console.log(`\nStats written to ${outPath}`);
}

const { values } = parseArgs({
  options: {
    ab: { type: "string" },
    "gen-responses": { type: "boolean" },
    "judge-d": { type: "boolean" },
    stats: { type: "boolean" },
  },
});

if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}

const modeFlags = (["gen-responses", "judge-d", "stats"] as const).filter(
  (m) => values[m],
);
if (modeFlags.length !== 1) {
  console.error(
    "exactly one of --gen-responses / --judge-d / --stats is required",
  );
  process.exit(1);
}

const abDirPath = abDir(resolveEvalHome(), values.ab);

if (modeFlags[0] === "gen-responses") {
  await runGenResponses(abDirPath);
} else if (modeFlags[0] === "judge-d") {
  await runJudgeD(abDirPath);
} else {
  await runStats(abDirPath);
}
