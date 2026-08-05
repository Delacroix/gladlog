/**
 * buildHaloArms.ts — 把 buildCorpus 产出的语料 run 变成光环实验的 A/B 臂:
 * control = 原味 prompt(臂 O),treatment = redactOutcomeLabels 涂抹版(臂 R)。
 * 目录布局与 blindAbPool.loadArm 的消费契约一致,后续 blindPool/judge/统计
 * 全部走现有 A/B 基建。抽样定种子、Win/Loss 分层等量,可复现。
 */
import fs from "fs-extra";
import path from "path";

import { makeRng } from "../ab/abCompareStats.js";
import type { IndexEntry } from "../corpus/buildCorpus";
import { redactOutcomeLabels } from "./redactOutcome.js";

function seededSample<T>(items: T[], n: number, rng: () => number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export async function buildHaloArms(opts: {
  sourceDir: string;
  outDir: string;
  nPerStratum: number;
  seed: number;
}): Promise<{ pairs: number; wins: number; losses: number }> {
  const { sourceDir, outDir, nPerStratum, seed } = opts;
  const entries = (await fs.readJson(
    path.join(sourceDir, "index.json"),
  )) as IndexEntry[];

  // Validate all entries in the source corpus
  for (const entry of entries) {
    const prompt = await fs.readFile(path.join(sourceDir, entry.file), "utf8");
    const redacted = redactOutcomeLabels(prompt);
    if (redacted.result !== entry.result)
      throw new Error(
        `buildHaloArms: ordinal ${entry.ordinal} result mismatch — index says ${entry.result}, prompt says ${redacted.result}`,
      );
  }

  const winPool = entries.filter((e) => e.result === "Win");
  const lossPool = entries.filter((e) => e.result === "Loss");
  if (winPool.length < nPerStratum || lossPool.length < nPerStratum)
    throw new Error(
      `buildHaloArms: stratum too small (Win ${winPool.length}, Loss ${lossPool.length}, need ${nPerStratum} each)`,
    );
  const rng = makeRng(seed);
  const selected = [
    ...seededSample(winPool, nPerStratum, rng),
    ...seededSample(lossPool, nPerStratum, rng),
  ].sort((a, b) => a.ordinal - b.ordinal);

  for (const arm of ["control", "treatment"] as const) {
    await fs.ensureDir(path.join(outDir, arm, "prompts"));
    await fs.ensureDir(path.join(outDir, arm, "responses"));
  }

  const rewritten: IndexEntry[] = [];
  for (const entry of selected) {
    const prompt = await fs.readFile(path.join(sourceDir, entry.file), "utf8");
    const redacted = redactOutcomeLabels(prompt);
    const relFile = path.join("prompts", path.basename(entry.file));
    await fs.writeFile(path.join(outDir, "control", relFile), prompt, "utf8");
    await fs.writeFile(
      path.join(outDir, "treatment", relFile),
      redacted.text,
      "utf8",
    );
    rewritten.push({ ...entry, file: relFile });
  }
  for (const arm of ["control", "treatment"] as const)
    await fs.writeJson(path.join(outDir, arm, "index.json"), rewritten, {
      spaces: 2,
    });
  await fs.writeJson(
    path.join(outDir, "sample-meta.json"),
    {
      seed,
      nPerStratum,
      sourceDir,
      ordinals: rewritten.map((e) => e.ordinal),
    },
    { spaces: 2 },
  );
  const wins = rewritten.filter((e) => e.result === "Win").length;
  return { pairs: rewritten.length, wins, losses: rewritten.length - wins };
}

export async function copyResponsesAcrossArms(
  haloDir: string,
): Promise<number> {
  const from = path.join(haloDir, "control", "responses");
  const to = path.join(haloDir, "treatment", "responses");
  const files = (await fs.readdir(from)).filter((f) => f.endsWith(".txt"));
  if (files.length === 0)
    throw new Error(`copyResponsesAcrossArms: no responses under ${from}`);
  await fs.ensureDir(to);
  for (const f of files)
    await fs.copy(path.join(from, f), path.join(to, f), { overwrite: true });
  return files.length;
}
