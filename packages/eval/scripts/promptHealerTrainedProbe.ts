/**
 * `[HEALER TRAINED] … — peel or reposition opportunity` V0/V1 探针 —— GH #36 第 3 项:
 * 「把行尾那句处方(peel or reposition opportunity)去掉、只留事实,教练会不会丢掉
 * 有用的 steering?」
 *
 * 同一局两份:V0 = 原 prompt;V1 = 同一行把 " — peel or reposition opportunity"
 * 换成 " — no CC on the healer during this window"(纯事实,与 ownerCcLocked 分支
 * 对称),其余一字不改。只植第一条这样的行。
 *
 * 判据确定性:结构化 findings 里落在该窗口 ±15s 的条目中,claim 命中
 * peel/reposition/走位/换位/拉开/保护治疗/驱赶 的条数(= 模型自己给出了 peel/走位
 * 建议),以及该窗口是否被讨论。V0−V1 之差就是这句处方的 steering 价值。
 *
 * 用法:
 *   npx tsx packages/eval/scripts/promptHealerTrainedProbe.ts \
 *     --list <清单> --matches 40 --out <目录> [--concurrency 4] [--backend agy]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  buildMatchContext,
  ensureAnalysisData,
  isHealerSpec,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";

import { parseLogCombats } from "../src/corpus/candidateMenu";
import { Breaker, callCli, type CliBackend } from "../src/explore/cliDriver";
import {
  parseFindings,
  STRUCTURED_SUFFIX,
  type StructuredFinding,
} from "../src/explore/promptLineTypes";
import {
  buildResponderMessages,
  callDeepseek,
} from "../src/family/deepseekDriver";

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const listPath = arg("--list");
const outDir = arg("--out");
if (!listPath || !outDir) {
  console.error(
    "Usage: promptHealerTrainedProbe --list <files.txt> --out <dir> [--matches N] [--concurrency K]",
  );
  process.exit(1);
}
const wantMatches = Number(arg("--matches", "100"));
const concurrency = Number(arg("--concurrency", "4"));
/** 后端选择与消融探针同一套(实测耗时与坑见 `src/explore/cliDriver.ts`)。 */
const backend = arg("--backend", "agy")!;
const cliModel = arg("--model");
const breaker = new Breaker(Number(arg("--breaker", "10")));
mkdirSync(outDir, { recursive: true });
await ensureAnalysisData();

interface Target {
  id: string;
  prompt: string;
  planted: string;
  atSeconds: number;
}

const ADVICE = " \u2014 peel or reposition opportunity";
const FACT = " \u2014 no CC on the healer during this window";
/** --variant legend (2026-08-29, user ruling on #36 item 3): V1 fact wording PLUS
 * one general rule stated once under the HEALER TRAINED header instead of a
 * per-line prescription. */
const LEGEND =
  "    (rule: a healer camped by melee for this long, with no CC on them, is a peel / reposition opportunity for the team)";
const VARIANT = arg("--variant", "fact");
function plant(lines: string[], idx: number): string[] {
  const out = [...lines];
  out[idx] = lines[idx]!.replace(ADVICE, FACT);
  if (VARIANT === "legend") {
    const h = out.findIndex((l) =>
      l.includes("HEALER TRAINED (enemy melee camped"),
    );
    if (h >= 0) out.splice(h + 1, 0, LEGEND);
  }
  return out;
}

function collect(limit: number): Target[] {
  const files = readFileSync(listPath!, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const out: Target[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let text = "";
    try {
      text = gunzipSync(readFileSync(f)).toString("utf8");
    } catch {
      continue;
    }
    let combats: ReturnType<typeof parseLogCombats> = [];
    try {
      combats = parseLogCombats(text);
    } catch {
      continue;
    }
    for (const c of combats) {
      if (out.length >= limit) break;
      const players = (Object.values(c.legacy.units) as never[]).filter(
        (u: never) => (u as { info?: unknown }).info,
      ) as Array<{ reaction: number; spec: never; name: string }>;
      const friends = players.filter(
        (u) => u.reaction === CombatUnitReaction.Friendly,
      );
      const enemies = players.filter(
        (u) => u.reaction !== CombatUnitReaction.Friendly,
      );
      const owner = friends.find((u) => isHealerSpec(u.spec));
      if (!owner || (c.legacy.endTime - c.legacy.startTime) / 1000 < 120)
        continue;
      let prompt = "";
      try {
        prompt = buildMatchContext(
          c.legacy as never,
          friends as never,
          enemies as never,
          { owner } as never,
        );
      } catch {
        continue;
      }
      const lines = prompt.split("\n");
      const idx = lines.findIndex((l) => l.includes(ADVICE));
      if (idx < 0) continue;
      const ts = lines[idx].trim().match(/^(\d+):(\d\d)/);
      if (!ts) continue;
      const planted = plant(lines, idx);
      out.push({
        id: `${f.split("/").pop()?.slice(0, 8)}-${out.length}`,
        prompt,
        planted: planted.join("\n"),
        atSeconds: Number(ts[1]) * 60 + Number(ts[2]),
      });
    }
  }
  return out;
}

const targets = collect(wantMatches);
console.log(
  `取到 ${targets.length} 局可植入(带 "peel or reposition opportunity" 行)`,
);
if (targets.length === 0) process.exit(1);

async function ask(text: string): Promise<string> {
  const msgs = buildResponderMessages(text);
  msgs[msgs.length - 1] = {
    ...msgs[msgs.length - 1],
    content: msgs[msgs.length - 1].content + STRUCTURED_SUFFIX,
  };
  try {
    const out =
      backend === "deepseek"
        ? await callDeepseek(msgs, { maxTokens: 6144, temperature: 0 })
        : await callCli(
            backend as CliBackend,
            msgs.map((m) => m.content).join("\n\n"),
            { model: cliModel },
          );
    breaker.ok();
    return out;
  } catch (e) {
    breaker.fail(e);
    return `__ERROR__ ${(e as Error).message}`;
  }
}

const PEEL_RE =
  /\bpeel|reposition|kite|line of sight|\bLoS\b|走位|换位|拉开|拉远|保护治疗|驱赶|驱离|脱离|卡视野/i;

function near(fs: StructuredFinding[], atSeconds: number) {
  const out: StructuredFinding[] = [];
  for (const f of fs) {
    const m = String(f.t ?? "").match(/(\d+):(\d\d)/);
    if (!m) continue;
    const s = Number(m[1]) * 60 + Number(m[2]);
    if (Math.abs(s - atSeconds) <= 15) out.push(f);
  }
  return out;
}

interface Side {
  mentions: number;
  peel: number;
  peelAnywhere: number;
  bad: number;
}
interface Res {
  id: string;
  atSeconds: number;
  v0: Side;
  v1: Side;
}
const results: Res[] = (() => {
  try {
    return JSON.parse(readFileSync(join(outDir!, "raw.json"), "utf8")) as Res[];
  } catch {
    return [];
  }
})();
if (results.length) console.log(`续跑:复用已有 ${results.length} 局结果`);
const doneIds = new Set(results.map((r) => r.id));
let done = 0;

function score(text: string, atSeconds: number): Side {
  const fs = parseFindings(text);
  const n = near(fs, atSeconds);
  return {
    mentions: n.length,
    peel: n.filter((f) => PEEL_RE.test(f.claim)).length,
    peelAnywhere: fs.filter((f) => PEEL_RE.test(f.claim)).length,
    bad: n.filter((f) => f.verdict === "bad").length,
  };
}

async function runOne(t: Target) {
  if (doneIds.has(t.id)) {
    done++;
    return;
  }
  const [a, b] = await Promise.all([ask(t.prompt), ask(t.planted)]);
  if ([a, b].some((x) => x.startsWith("__ERROR__"))) {
    done++;
    return;
  }
  results.push({
    id: t.id,
    atSeconds: t.atSeconds,
    v0: score(a, t.atSeconds),
    v1: score(b, t.atSeconds),
  });
  done++;
  if (done % 5 === 0) console.log(`  ${done}/${targets.length}`);
  if (done % 5 === 0)
    writeFileSync(join(outDir!, "raw.json"), JSON.stringify(results));
}

async function pool<T>(items: T[], k: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(k, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
console.log(
  `共 ${targets.length * 2} 次模型调用(已完成 ${doneIds.size} 局可跳过),后端 ${backend}${cliModel ? `/${cliModel}` : ""},并发 ${concurrency}`,
);
try {
  await pool(targets, concurrency, runOne);
} catch (e) {
  console.error(
    `\n⚠ 中止:${(e as Error).message}\n已完成 ${results.length} 局,照常落盘出报告。`,
  );
}

writeFileSync(join(outDir, "raw.json"), JSON.stringify(results));
const n = results.length;
const S = (k: "v0" | "v1", f: keyof Side) =>
  results.reduce((s, r) => s + r[k][f], 0);
const W = (k: "v0" | "v1", f: keyof Side) =>
  results.filter((r) => r[k][f] > 0).length;
const pct = (a: number, b: number) =>
  b ? `${((100 * a) / b).toFixed(0)}%` : "-";
const lines = [
  `# [HEALER TRAINED] 处方句 V0/V1 探针(GH #36 第 3 项)— variant=${VARIANT}`,
  ``,
  `同一局两份:V0 原文(… — peel or reposition opportunity)/ V1 事实化(… — no CC on the healer during this window)。有效对局 ${n}。`,
  ``,
  `| 版本 | 讨论了该窗口的对局 | 窗口内 peel/走位类建议(条) | 有此建议的对局 | 全文 peel/走位类建议(条) | 窗口内 bad 裁决 |`,
  `|---|---:|---:|---:|---:|---:|`,
  `| V0 原文 | ${W("v0", "mentions")} (${pct(W("v0", "mentions"), n)}) | ${S("v0", "peel")} | ${W("v0", "peel")} (${pct(W("v0", "peel"), n)}) | ${S("v0", "peelAnywhere")} | ${S("v0", "bad")} |`,
  `| V1 事实化 | ${W("v1", "mentions")} (${pct(W("v1", "mentions"), n)}) | ${S("v1", "peel")} | ${W("v1", "peel")} (${pct(W("v1", "peel"), n)}) | ${S("v1", "peelAnywhere")} | ${S("v1", "bad")} |`,
  ``,
  `配对差(同局):V1 比 V0 少了窗口内 peel 建议的对局 ${results.filter((r) => r.v1.peel < r.v0.peel).length},多了的 ${results.filter((r) => r.v1.peel > r.v0.peel).length},相同 ${results.filter((r) => r.v1.peel === r.v0.peel).length}。`,
  `判据:窗口 ±15s 内的 findings,claim 命中 peel/reposition/kite/LoS/走位/换位/拉开/保护治疗/驱赶 之一。`,
];
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log(`\n${lines.join("\n")}`);
