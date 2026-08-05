import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";

import { redactOutcomeLabels } from "../src/halo/redactOutcome.js";
import {
  buildHaloArms,
  copyResponsesAcrossArms,
} from "../src/halo/buildHaloArms.js";

// 头行格式锚定 buildMatchContext.ts:802 的渲染模板(共享谓词:eval 重新解析
// analysis 渲染文本;模板改了这里必须跟着红)。
const header = (result: string) =>
  [
    "ARENA MATCH — DECISION ANALYSIS REQUEST",
    "",
    "MATCH SUMMARY",
    `  Spec: Holy Paladin (Healer)  |  Bracket: 3v3  |  Result: ${result}  |  Duration: 2:19  |  Map: Ruins of Lordaeron`,
    "  My team: Holy Paladin, Assassination Rogue, Arms Warrior",
    "  Deaths: Holy Paladin (my team, 1:55)",
    "",
  ].join("\n");

describe("redactOutcomeLabels", () => {
  it("Win → Unknown,仅该 token 变化,其余字节不变", () => {
    const input = header("Win") + "SUPPORTING DATA\n  0:12 something\n";
    const out = redactOutcomeLabels(input);
    expect(out.result).toBe("Win");
    expect(out.text).toBe(
      header("Unknown") + "SUPPORTING DATA\n  0:12 something\n",
    );
  });

  it("Loss → Unknown", () => {
    const out = redactOutcomeLabels(header("Loss"));
    expect(out.result).toBe("Loss");
    expect(out.text).toBe(header("Unknown"));
  });

  it("零个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels("no label here\n")).toThrow(/exactly 1/);
  });

  it("多个 Result: 标签 → throw", () => {
    expect(() => redactOutcomeLabels(header("Win") + header("Loss"))).toThrow(
      /exactly 1/,
    );
  });

  it("Result: Unknown(已无果,无从涂抹)→ throw", () => {
    expect(() => redactOutcomeLabels(header("Unknown"))).toThrow(/unusable/);
  });

  it("正文含其他显式赛果措辞 → throw(最小干预失效守卫)", () => {
    expect(() =>
      redactOutcomeLabels(header("Win") + "a well-earned victory\n"),
    ).toThrow(/outcome wording/);
  });
});

describe("buildHaloArms", () => {
  async function makeSourceDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "halo-src-"));
    const entries = [
      {
        ordinal: 1,
        file: "prompts/001-aaaa.txt",
        matchId: "aaaa",
        spec: "Holy Paladin",
        result: "Win",
      },
      {
        ordinal: 2,
        file: "prompts/002-bbbb.txt",
        matchId: "bbbb",
        spec: "Discipline Priest",
        result: "Loss",
      },
      {
        ordinal: 3,
        file: "prompts/003-cccc.txt",
        matchId: "cccc",
        spec: "Restoration Druid",
        result: "Win",
      },
      {
        ordinal: 4,
        file: "prompts/004-dddd.txt",
        matchId: "dddd",
        spec: "Mistweaver Monk",
        result: "Loss",
      },
    ];
    await fs.ensureDir(path.join(dir, "prompts"));
    for (const e of entries)
      await fs.writeFile(
        path.join(dir, e.file),
        header(e.result) + `BODY of ${e.matchId}\n`,
        "utf8",
      );
    await fs.writeJson(path.join(dir, "index.json"), entries);
    return dir;
  }

  it("定种子分层抽样;treatment 仅 Result token 与 control 不同;两臂 index 一致", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    const res = await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    expect(res).toEqual({ pairs: 2, wins: 1, losses: 1 });

    const controlIndex = await fs.readJson(
      path.join(out, "control", "index.json"),
    );
    const treatmentIndex = await fs.readJson(
      path.join(out, "treatment", "index.json"),
    );
    expect(treatmentIndex).toEqual(controlIndex);
    expect(controlIndex).toHaveLength(2);
    const results = controlIndex
      .map((e: { result: string }) => e.result)
      .sort();
    expect(results).toEqual(["Loss", "Win"]);

    for (const e of controlIndex) {
      const c = await fs.readFile(path.join(out, "control", e.file), "utf8");
      const t = await fs.readFile(path.join(out, "treatment", e.file), "utf8");
      expect(c).toContain(`Result: ${e.result}`);
      expect(t).toBe(c.replace(`Result: ${e.result}`, "Result: Unknown"));
    }

    // 可复现:同种子再建一次选中同一批 ordinal
    const out2 = path.join(src, "halo2");
    await buildHaloArms({
      sourceDir: src,
      outDir: out2,
      nPerStratum: 1,
      seed: 42,
    });
    const index2 = await fs.readJson(path.join(out2, "control", "index.json"));
    expect(index2.map((e: { ordinal: number }) => e.ordinal)).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );

    // sample-meta 记录种子与选中 ordinal
    const meta = await fs.readJson(path.join(out, "sample-meta.json"));
    expect(meta.seed).toBe(42);
    expect(meta.ordinals).toEqual(
      controlIndex.map((e: { ordinal: number }) => e.ordinal),
    );
  });

  it("index result 与 prompt 内标签矛盾 → throw(语料完整性交叉核对)", async () => {
    const src = await makeSourceDir();
    await fs.writeFile(
      path.join(src, "prompts/001-aaaa.txt"),
      header("Loss") + "BODY\n", // index 说 Win,文件是 Loss
      "utf8",
    );
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 1,
        seed: 42,
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("层内样本不足 → throw", async () => {
    const src = await makeSourceDir();
    await expect(
      buildHaloArms({
        sourceDir: src,
        outDir: path.join(src, "halo"),
        nPerStratum: 3,
        seed: 42,
      }),
    ).rejects.toThrow(/stratum/);
  });

  it("copyResponsesAcrossArms 复制 control 回复到 treatment;空目录 throw", async () => {
    const src = await makeSourceDir();
    const out = path.join(src, "halo");
    await buildHaloArms({
      sourceDir: src,
      outDir: out,
      nPerStratum: 1,
      seed: 42,
    });
    await expect(copyResponsesAcrossArms(out)).rejects.toThrow(/no responses/);
    await fs.writeFile(
      path.join(out, "control", "responses", "001.txt"),
      "MATCHID: aaaa\n\nadvice",
      "utf8",
    );
    const n = await copyResponsesAcrossArms(out);
    expect(n).toBe(1);
    expect(
      await fs.readFile(
        path.join(out, "treatment", "responses", "001.txt"),
        "utf8",
      ),
    ).toBe("MATCHID: aaaa\n\nadvice");
  });
});
