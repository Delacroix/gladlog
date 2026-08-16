/**
 * sycophancyEval.ts CLI — D2 问教练谄媚性(子项目 D)三子命令:
 *
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --build [--ab <abId>] --out <dir>
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --judge-d --dir <dir>
 *   npx tsx packages/eval/scripts/sycophancyEval.ts --stats --dir <dir>
 *
 * 三步顺序运行:
 *   1. `--build`:前置条件只有一个——`<abId>`(默认
 *      `2026-08-06-planted-accuracy`,controller 2026-08-06 fix round 1 定案:
 *      按 design spec 字面口径走这个现成的 AB,不再依赖 family-bias/D1 的盲
 *      池)已经建好 `blind/{mapping.json,scores/,items/}` 且判完——这份 AB
 *      本身已在盘上完整存在(300 份 K=3 判分),不需要先跑任何 familyBias
 *      子命令。从其 control 臂(未种植时间戳错误的原始回复)的 verified
 *      factAudit 里定种子采样挑战,为每条写好 `coach-sim-prompts/<id>.txt`
 *      (orchestrator 派 sonnet 子代理续聊教练用的完整输入)——sonnet 的续聊
 *      回复由 orchestrator 写回 `coach-replies/<id>.txt`,S 判官的分类同样
 *      由 orchestrator 派 sonnet 子代理(读 `SYCO_JUDGE_INSTRUCTIONS`)写
 *      `scores-s/<id>.json`,两者都不在本 CLI 范围内(D 判官走本 CLI 的
 *      `--judge-d`,与 familyBias 的 S/D 判官分工同构)。
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

/**
 * 读一个 control 臂 blindId 的判分文件,取 factAudit。plant-accuracy 的盲池
 * 是 K=3(judge-noise-floor 设计,见
 * docs/superpowers/specs/2026-08-05-judge-noise-floor-design.md)——分数文件
 * 命名 `<blindId>.r1.json`/`.r2.json`/`.r3.json`(`abCompareStats.ts` 的
 * `collectReplicateFiles` 认的同一套命名),不是 D1 family-bias 盲池那种
 * `<blindId>.json` 单份。三个副本对同一份回复各自独立判过一遍,任何一份都
 * 是「已核实」claim 的合法来源;这里定死读 r1(不是「r1 更准」,只是要选一
 * 个确定的、可复现的副本,不在三份之间做任何取舍)。
 *
 * 同时兼容 `<blindId>.json` 扁平命名(优先尝试)——单测用的合成 fixture
 * 没有理由背上 K=3 的复杂度,扁平命名让 sycophancy.test.ts 之外如果有人拿
 * 一份非 K-replicate 的盲池(比如未来某个 K=1 的 AB)喂给同一个 CLI 也能
 * 直接工作。
 */
async function loadControlScoreFile(
  scoresDir: string,
  blindId: string,
): Promise<ScoredBlindItem | null> {
  const flatPath = path.join(scoresDir, `${blindId}.json`);
  if (await fs.pathExists(flatPath)) {
    const raw = (await fs.readJson(flatPath)) as {
      factAudit?: ScoredBlindItem["factAudit"];
    };
    return { blindId, factAudit: raw.factAudit };
  }
  const r1Path = path.join(scoresDir, `${blindId}.r1.json`);
  if (await fs.pathExists(r1Path)) {
    const raw = (await fs.readJson(r1Path)) as {
      factAudit?: ScoredBlindItem["factAudit"];
    };
    return { blindId, factAudit: raw.factAudit };
  }
  return null;
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
  // 只读 control 臂——treatment 臂的回复被 plantTimestampError.ts 种植过时
  // 间戳错误,从它的 factAudit 取反构造挑战有污染源风险(见文件头注释)。
  // buildChallenges 自己也会按 mapping 过滤 arm,这里提前只喂 control 臂
  // 是双重保险,不是唯一防线。
  const scoreFiles: ScoredBlindItem[] = [];
  let missingScoreFile = 0;
  for (const m of mapping.filter((item) => item.arm === "control")) {
    const sf = await loadControlScoreFile(scoresDir, m.blindId);
    if (sf) scoreFiles.push(sf);
    else missingScoreFile++;
  }
  if (missingScoreFile > 0) {
    console.warn(
      `  ${missingScoreFile} 个 control 臂 blindId 在 ${scoresDir} 下既无 <blindId>.json 也无 <blindId>.r1.json,已跳过`,
    );
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

/** 读一个族(scores-s/scores-d)目录下所有 `.json` 分类文件,拆成合法解析
 * 出的 `items` 与「读了但形状不对」的 `malformed` 计数——不能静默丢弃后者:
 * n 会因此缩水,不报出来读者会误以为「一致率是在完整样本上算的」。 */
async function readClassifications(
  dir: string,
): Promise<{ items: ClassificationItem[]; malformed: number }> {
  if (!(await fs.pathExists(dir))) return { items: [], malformed: 0 };
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const items: ClassificationItem[] = [];
  let malformed = 0;
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
    } else {
      malformed++;
    }
  }
  return { items, malformed };
}

async function runStats(outDir: string): Promise<void> {
  const s = await readClassifications(path.join(outDir, "scores-s"));
  const d = await readClassifications(path.join(outDir, "scores-d"));
  const report = sycoStats(s.items, d.items);
  const outPath = path.join(outDir, "sycophancy-stats.json");
  await fs.writeJson(
    outPath,
    { ...report, malformedS: s.malformed, malformedD: d.malformed },
    { spaces: 2 },
  );
  console.log(renderSycoStatsMarkdown(report));
  console.log(
    `Malformed score files skipped (not counted in n above): S=${s.malformed}, D=${d.malformed}`,
  );
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

// Controller 2026-08-06 fix round 1 定案:D2 挑战源就是这份 AB,不依赖
// family-bias/D1 先跑完——默认值让 --build 不带 --ab 也能直接跑。
const DEFAULT_CHALLENGE_SOURCE_AB = "2026-08-06-planted-accuracy";

if (modeFlags[0] === "build") {
  if (!values.out) {
    console.error("--build requires --out <dir>");
    process.exit(1);
  }
  const home = resolveEvalHome();
  const abId = values.ab ?? DEFAULT_CHALLENGE_SOURCE_AB;
  await runBuild(abDir(home, abId), values.out, {
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
