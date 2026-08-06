/**
 * sycophancyEval.ts CLI — D2 问教练谄媚性(子项目 D)三子命令:
 *
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --build --ab <abId> --out <dir>
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --judge-d --dir <dir>
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --stats --dir <dir>
 *
 * 三步顺序运行:
 *   1. `--build`:从 `<abId>`(family-bias 的盲池,已由 `blindPool.ts` +
 *      familyBias 的 `--judge-d` 建好 `blind/{mapping.json,scores/,items/}`)
 *      的 control 臂 verified factAudit 里定种子采样挑战,为每条写好
 *      `coach-sim-prompts/<id>.txt`(orchestrator 派 sonnet 子代理续聊教练
 *      用的完整输入)——sonnet 的续聊回复由 orchestrator 写回
 *      `coach-replies/<id>.txt`,S 判官的分类同样由 orchestrator 派 sonnet
 *      子代理(读 `SYCO_JUDGE_INSTRUCTIONS`)写 `scores-s/<id>.json`,两者都
 *      不在本 CLI 范围内(与 familyBias 的 S 判官走子代理、D 判官走本 CLI
 *      同一分工)。
 *   2. `--judge-d`:对已产出的 `coach-replies/<id>.txt` 逐条调 DeepSeek 判官
 *      (三分类 holds/caves/hedges),写 `scores-d/<id>.json`,断点续跑。
 *   3. `--stats`:读 `scores-s/` + `scores-d/`,算缴械率/含糊率/双判一致率,
 *      写 `sycophancy-stats.json`。
 *
 * 全部逻辑在 src/family/sycophancy.ts / deepseekDriver.ts,这里只做参数解析
 * 与 fs/网络 IO 编排(与 familyBias.ts CLI 同一分层)。
 */
import { parseArgs } from "node:util";

import fs from "fs-extra";
import path from "path";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import {
  callDeepseek,
  parseScoreObject,
} from "../src/family/deepseekDriver.js";
import {
  buildChallenges,
  buildCoachSimPrompt,
  buildSycoJudgeMessages,
  type Challenge,
  type ClassificationItem,
  type MappingItem,
  renderSycoStatsMarkdown,
  type ScoredBlindItem,
  type SycoClassification,
  sycoStats,
} from "../src/family/sycophancy.js";

const SYCO_CLASSIFICATIONS: readonly SycoClassification[] = [
  "holds",
  "caves",
  "hedges",
];

/** `--build` 写进 `challenges.json` 的存档形状:在纯函数 `Challenge` 之上
 * 多带一份 `responseText`(原始教练回复全文),这样 `--judge-d`/`--stats`
 * 只需要读 `challenges.json` 就能拿到 `buildSycoJudgeMessages` 要的三段材
 * 料之一,不必回头依赖 `<abId>` 那份盲池目录还在(sycophancy 产物目录自
 * 包含)。 */
interface StoredChallenge extends Challenge {
  responseText: string;
}

async function runBuild(
  abDirPath: string,
  outDir: string,
  opts: { seed: number; count: number; minMatches: number },
): Promise<void> {
  const { mapping } = (await fs.readJson(
    path.join(abDirPath, "blind", "mapping.json"),
  )) as { mapping: MappingItem[] };

  const scoresDir = path.join(abDirPath, "blind", "scores");
  const scoreFiles: ScoredBlindItem[] = [];
  for (const blindId of (await fs.readdir(scoresDir)).filter((f) =>
    f.endsWith(".json"),
  )) {
    const raw = (await fs.readJson(path.join(scoresDir, blindId))) as {
      factAudit?: ScoredBlindItem["factAudit"];
    };
    scoreFiles.push({
      blindId: blindId.replace(/\.json$/, ""),
      factAudit: raw.factAudit,
    });
  }

  const challenges = buildChallenges(scoreFiles, mapping, opts);

  await fs.ensureDir(path.join(outDir, "coach-sim-prompts"));
  await fs.ensureDir(path.join(outDir, "coach-replies"));
  await fs.ensureDir(path.join(outDir, "scores-s"));
  await fs.ensureDir(path.join(outDir, "scores-d"));

  const stored: StoredChallenge[] = [];
  for (const c of challenges) {
    const itemDir = path.join(abDirPath, "blind", "items", c.blindId);
    const promptText = await fs.readFile(
      path.join(itemDir, "prompt.txt"),
      "utf8",
    );
    const responseText = await fs.readFile(
      path.join(itemDir, "response.txt"),
      "utf8",
    );
    const simPrompt = buildCoachSimPrompt(
      promptText,
      responseText,
      c.challengeText,
    );
    await fs.writeFile(
      path.join(outDir, "coach-sim-prompts", `${c.id}.txt`),
      simPrompt,
      "utf8",
    );
    stored.push({ ...c, responseText });
  }

  await fs.writeJson(
    path.join(outDir, "challenges.json"),
    {
      generatedAt: new Date().toISOString(),
      sourceAb: abDirPath,
      ...opts,
      challenges: stored,
    },
    { spaces: 2 },
  );

  console.log(
    `build: ${stored.length} 挑战,coach-sim-prompts/ 已写(等 orchestrator 派 sonnet 子代理续聊 → coach-replies/,S 判官分类 → scores-s/),输出 ${outDir}`,
  );
}

async function loadStoredChallenges(
  outDir: string,
): Promise<StoredChallenge[]> {
  const { challenges } = (await fs.readJson(
    path.join(outDir, "challenges.json"),
  )) as { challenges: StoredChallenge[] };
  return challenges;
}

async function runJudgeD(outDir: string): Promise<void> {
  const challenges = await loadStoredChallenges(outDir);
  const repliesDir = path.join(outDir, "coach-replies");
  const outScoresDir = path.join(outDir, "scores-d");
  await fs.ensureDir(outScoresDir);

  let judged = 0;
  let skipped = 0;
  let noReply = 0;
  let failed = 0;
  for (const c of challenges) {
    const scorePath = path.join(outScoresDir, `${c.id}.json`);
    if (await fs.pathExists(scorePath)) {
      skipped++;
      continue;
    }
    const replyPath = path.join(repliesDir, `${c.id}.txt`);
    if (!(await fs.pathExists(replyPath))) {
      noReply++;
      continue;
    }
    const coachReply = await fs.readFile(replyPath, "utf8");
    const raw = await callDeepseek(
      buildSycoJudgeMessages(c.responseText, c.challengeText, coachReply),
    );
    const parsed = parseScoreObject(raw) as Record<string, unknown> | null;
    const classification = parsed?.classification;
    if (
      !parsed ||
      typeof classification !== "string" ||
      !SYCO_CLASSIFICATIONS.includes(classification as SycoClassification) ||
      typeof parsed.basis !== "string"
    ) {
      console.error(
        `  ${c.id}: DeepSeek 判分未能解析为合法三分类 JSON,跳过(可重跑续补)`,
      );
      failed++;
      continue;
    }
    await fs.writeJson(
      scorePath,
      {
        id: c.id,
        classification,
        basis: parsed.basis,
        judgeModel: "deepseek-chat",
        judgedAt: new Date().toISOString(),
      },
      { spaces: 2 },
    );
    judged++;
  }
  console.log(
    `judge-d: ${judged} 判分,${skipped} 已存在跳过,${noReply} 尚无 coach-replies,${failed} 解析失败,输出 ${outScoresDir}`,
  );
}

async function readClassifications(dir: string): Promise<ClassificationItem[]> {
  if (!(await fs.pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const items: ClassificationItem[] = [];
  for (const f of files) {
    const raw = (await fs.readJson(path.join(dir, f))) as Record<
      string,
      unknown
    >;
    const id = typeof raw.id === "string" ? raw.id : f.replace(/\.json$/, "");
    const classification = raw.classification;
    if (
      typeof classification === "string" &&
      SYCO_CLASSIFICATIONS.includes(classification as SycoClassification) &&
      typeof raw.basis === "string"
    ) {
      items.push({
        id,
        classification: classification as SycoClassification,
        basis: raw.basis,
      });
    }
  }
  return items;
}

async function runStats(outDir: string): Promise<void> {
  const sClassifications = await readClassifications(
    path.join(outDir, "scores-s"),
  );
  const dClassifications = await readClassifications(
    path.join(outDir, "scores-d"),
  );
  const report = sycoStats(sClassifications, dClassifications);
  const outPath = path.join(outDir, "sycophancy-stats.json");
  await fs.writeJson(outPath, report, { spaces: 2 });
  console.log(renderSycoStatsMarkdown(report));
  console.log(`\nStats written to ${outPath}`);
}

const { values } = parseArgs({
  options: {
    ab: { type: "string" },
    out: { type: "string" },
    dir: { type: "string" },
    build: { type: "boolean" },
    "judge-d": { type: "boolean" },
    stats: { type: "boolean" },
    seed: { type: "string" },
    count: { type: "string" },
    "min-matches": { type: "string" },
  },
});

const modeFlags = (["build", "judge-d", "stats"] as const).filter(
  (m) => values[m],
);
if (modeFlags.length !== 1) {
  console.error("exactly one of --build / --judge-d / --stats is required");
  process.exit(1);
}

if (modeFlags[0] === "build") {
  if (!values.ab || !values.out) {
    console.error("--build requires --ab <abId> and --out <dir>");
    process.exit(1);
  }
  const home = resolveEvalHome();
  await runBuild(abDir(home, values.ab), values.out, {
    // 与 plantAccuracyAb.ts 的默认种子同一惯例(定死一个日期形状的常量,不
    // 是随便选的数字)。
    seed: Number(values.seed ?? 20260806),
    count: Number(values.count ?? 30),
    minMatches: Number(values["min-matches"] ?? 10),
  });
} else if (modeFlags[0] === "judge-d") {
  if (!values.dir) {
    console.error("--judge-d requires --dir <dir>");
    process.exit(1);
  }
  await runJudgeD(values.dir);
} else {
  if (!values.dir) {
    console.error("--stats requires --dir <dir>");
    process.exit(1);
  }
  await runStats(values.dir);
}
