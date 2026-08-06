import { mkdtempSync } from "fs";
import fs from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import path from "path";

import type { ScoreFile } from "../src/ab/abCompareStats";
import {
  accuracyVerdictBreakdown,
  computeFamilyStats,
  diffInDiff,
  type DiffInDiffCells,
  extractStep3Rubric,
  renderFamilyStatsMarkdown,
} from "../src/family/familyBias";

function score(
  accuracy: number,
  factAudit?: ScoreFile["factAudit"],
): ScoreFile {
  return { prompt: {}, response: { accuracy }, factAudit };
}

describe("diffInDiff", () => {
  it("四格数组长度不等 → throw", () => {
    const cells: DiffInDiffCells = {
      sjSr: [score(4)],
      djSr: [score(4), score(3)],
      sjDr: [score(4)],
      djDr: [score(4)],
    };
    expect(() => diffInDiff(cells, ["accuracy"])).toThrow(/长度必须相等/);
  });

  it("手算配对:2 item,familyBias 与 harshness 精确匹配", () => {
    // item 1: sjSr=5 djSr=3 sjDr=4 djDr=4 → delta=(5-3)-(4-4)=2
    // item 2: sjSr=3 djSr=3 sjDr=2 djDr=4 → delta=(3-3)-(2-4)=2
    const cells: DiffInDiffCells = {
      sjSr: [score(5), score(3)],
      djSr: [score(3), score(3)],
      sjDr: [score(4), score(2)],
      djDr: [score(4), score(4)],
    };
    const [result] = diffInDiff(cells, ["accuracy"]);
    expect(result.dimension).toBe("accuracy");
    expect(result.n).toBe(2);
    expect(result.familyBias).toBeCloseTo(2, 10);
    // harshness terms: (5-3),(3-3),(4-4),(2-4) = 2,0,0,-2 → mean 0
    expect(result.harshness).toBeCloseTo(0, 10);
    expect(result.harshnessN).toBe(4);
  });

  it("某 item 某维四格之一缺值 → 该 item 在该维度被跳过,不影响 n", () => {
    const cells: DiffInDiffCells = {
      sjSr: [score(5), { prompt: {}, response: {} }],
      djSr: [score(3), score(3)],
      sjDr: [score(4), score(2)],
      djDr: [score(4), score(4)],
    };
    const [result] = diffInDiff(cells, ["accuracy"]);
    expect(result.n).toBe(1);
  });

  it("维度缺省时按 DIMENSIONS 全部 7 维输出", () => {
    const cells: DiffInDiffCells = {
      sjSr: [score(5)],
      djSr: [score(3)],
      sjDr: [score(4)],
      djDr: [score(4)],
    };
    const results = diffInDiff(cells);
    // 除 accuracy(response 侧,已填)外其余 6 维在这些 fixture 里都是 null(未填
    // prompt 侧字段),n=0 应整维被跳过——只剩 accuracy 一条。
    expect(results.map((r) => r.dimension)).toEqual(["accuracy"]);
  });

  describe("注入偏差仿真(关键正确性钉子)", () => {
    // 20 item,交替 ±0.4(奇偶各 10 条):sjDr/djDr 固定相等(该臂无偏差、无噪声),
    // 差异只来自 sjSr/djSr 的交替值 —— 保证 baseline familyBias 精确为 0 且
    // bootstrap 分布关于 0 对称(两个可能值 ±0.4 都会被重抽样覆盖到)。
    function baselineCells(): DiffInDiffCells {
      const sjSr: ScoreFile[] = [];
      const djSr: ScoreFile[] = [];
      const sjDr: ScoreFile[] = [];
      const djDr: ScoreFile[] = [];
      for (let i = 0; i < 20; i++) {
        const even = i % 2 === 0;
        sjSr.push(score(even ? 3.4 : 2.6));
        djSr.push(score(3.0));
        sjDr.push(score(3.0));
        djDr.push(score(3.0));
      }
      return { sjSr, djSr, sjDr, djDr };
    }

    it("对称噪声(无注入偏差)→ familyBias≈0,CI 含零", () => {
      const [result] = diffInDiff(baselineCells(), ["accuracy"]);
      expect(result.familyBias).toBeCloseTo(0, 10);
      expect(result.ci95.lo).toBeLessThanOrEqual(0);
      expect(result.ci95.hi).toBeGreaterThanOrEqual(0);
    });

    it("S判(S回)全体 +0.5 → familyBias≈+0.5,CI 不含零", () => {
      const cells = baselineCells();
      // 全体 sjSr +0.5:偶数项 3.4→3.9,奇数项 2.6→3.1 —— 两个新 delta
      // (0.9 与 0.1)都严格 > 0,任何 bootstrap 重抽样的均值也必然 > 0,
      // 所以 CI 下界必然 > 0(不是概率性的,是这组合成数据的代数保证)。
      cells.sjSr = cells.sjSr.map((s) =>
        score((s.response!.accuracy as number) + 0.5),
      );
      const [result] = diffInDiff(cells, ["accuracy"]);
      expect(result.familyBias).toBeCloseTo(0.5, 10);
      expect(result.ci95.lo).toBeGreaterThan(0);
      expect(result.ci95.hi).toBeGreaterThan(0);
    });
  });
});

describe("accuracyVerdictBreakdown", () => {
  const va = { claim: "c", evidence: "e", verdict: "verified" as const };
  const rf = {
    claim: "c",
    evidence: "e",
    verdict: "refuted" as const,
    severity: "minor" as const,
  };
  const un = {
    claim: "c",
    evidence: "e",
    verdict: "unsupported" as const,
    severity: "minor" as const,
  };

  it("逐 verdict 计数与 meanPerItem 正确;无 factAudit 的份不计入 n", () => {
    const sJudge = [
      score(5, [va, va]),
      score(3, [va, rf, un]),
      score(4), // 无 factAudit → 不计入 n
    ];
    const dJudge = [score(5, [va]), score(2, [rf, rf, un])];
    const { sJudge: sOut, dJudge: dOut } = accuracyVerdictBreakdown(
      sJudge,
      dJudge,
    );
    expect(sOut.n).toBe(2);
    expect(sOut.verified).toBe(3);
    expect(sOut.refuted).toBe(1);
    expect(sOut.unsupported).toBe(1);
    expect(sOut.total).toBe(5);
    expect(sOut.meanPerItem.verified).toBeCloseTo(1.5, 10);

    expect(dOut.n).toBe(2);
    expect(dOut.verified).toBe(1);
    expect(dOut.refuted).toBe(2);
    expect(dOut.unsupported).toBe(1);
  });

  it("两族都全无 factAudit → n=0,meanPerItem 全 0(不除以零报 NaN)", () => {
    const { sJudge, dJudge } = accuracyVerdictBreakdown(
      [score(5), score(4)],
      [score(3)],
    );
    expect(sJudge.n).toBe(0);
    expect(sJudge.meanPerItem).toEqual({
      verified: 0,
      refuted: 0,
      unsupported: 0,
    });
    expect(dJudge.n).toBe(0);
  });
});

describe("extractStep3Rubric", () => {
  it("抽取 Step3 到下一个二级标题之间的原文(含标题,不含下一标题)", () => {
    const doc = [
      "# Title",
      "",
      "## Step 2: foo",
      "step2 body",
      "",
      "## Step 3: bar",
      "step3 line 1",
      "step3 line 2",
      "",
      "## Step 4: baz",
      "step4 body",
    ].join("\n");
    const out = extractStep3Rubric(doc);
    expect(out).toContain("## Step 3: bar");
    expect(out).toContain("step3 line 1");
    expect(out).toContain("step3 line 2");
    expect(out).not.toContain("step2 body");
    expect(out).not.toContain("## Step 4");
    expect(out).not.toContain("step4 body");
  });

  it("Step 3 是文档末尾(无下一个二级标题)也能正确抽到底", () => {
    const doc = ["## Step 3: bar", "line 1", "line 2"].join("\n");
    expect(extractStep3Rubric(doc)).toBe(doc);
  });

  it("找不到 '## Step 3' 标题 → throw", () => {
    expect(() => extractStep3Rubric("# Title\n\nno step 3 here")).toThrow(
      /Step 3/,
    );
  });

  it("对真实 docs/commands/eval-baseline.md 抽取:含三遍法/rubric,不含 Step 4", () => {
    const docPath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "docs",
      "commands",
      "eval-baseline.md",
    );
    const md = fs.readFileSync(docPath, "utf8");
    const rubric = extractStep3Rubric(md);
    expect(rubric).toContain("## Step 3");
    expect(rubric).toContain("三遍法");
    expect(rubric).toContain("PASS 1");
    expect(rubric).not.toContain("## Step 4");
  });
});

describe("computeFamilyStats(fs 编排,mkdtemp fixture)", () => {
  function writeScore(dir: string, blindId: string, s: ScoreFile) {
    fs.writeJsonSync(join(dir, `${blindId}.json`), s);
  }

  it("2 ordinal 双臂、S/D 两族判官分数齐全 → 配对 2 对,accuracy familyBias 精确计算", () => {
    const abDirPath = mkdtempSync(join(tmpdir(), "gl-family-"));
    fs.ensureDirSync(join(abDirPath, "blind", "scores"));
    fs.ensureDirSync(join(abDirPath, "blind", "scores-d"));

    const mapping = [
      { blindId: "item-01", arm: "control", ordinal: 1, matchId: "item-01" },
      { blindId: "item-02", arm: "treatment", ordinal: 1, matchId: "item-02" },
      { blindId: "item-03", arm: "control", ordinal: 2, matchId: "item-03" },
      { blindId: "item-04", arm: "treatment", ordinal: 2, matchId: "item-04" },
    ];
    fs.writeJsonSync(join(abDirPath, "blind", "mapping.json"), { mapping });

    // ordinal 1: sjSr=5 djSr=3 sjDr=4 djDr=4 → delta=2
    writeScore(join(abDirPath, "blind", "scores"), "item-01", score(5));
    writeScore(join(abDirPath, "blind", "scores-d"), "item-01", score(3));
    writeScore(join(abDirPath, "blind", "scores"), "item-02", score(4));
    writeScore(join(abDirPath, "blind", "scores-d"), "item-02", score(4));
    // ordinal 2: sjSr=3 djSr=3 sjDr=2 djDr=4 → delta=2
    writeScore(join(abDirPath, "blind", "scores"), "item-03", score(3));
    writeScore(join(abDirPath, "blind", "scores-d"), "item-03", score(3));
    writeScore(join(abDirPath, "blind", "scores"), "item-04", score(2));
    writeScore(join(abDirPath, "blind", "scores-d"), "item-04", score(4));

    return computeFamilyStats(abDirPath).then((report) => {
      expect(report.pairs).toBe(2);
      expect(report.missingSJudge).toBe(0);
      expect(report.missingDJudge).toBe(0);
      const accuracyDim = report.dimensions.find(
        (d) => d.dimension === "accuracy",
      );
      expect(accuracyDim).toBeDefined();
      expect(accuracyDim!.n).toBe(2);
      expect(accuracyDim!.familyBias).toBeCloseTo(2, 10);
      const md = renderFamilyStatsMarkdown(report);
      expect(md).toContain("accuracy");
      expect(md).toContain("Pairs: 2");
    });
  });

  it("缺 D 判官分数的 item → 该 ordinal 配对被跳过,missingDJudge 计数", () => {
    const abDirPath = mkdtempSync(join(tmpdir(), "gl-family-"));
    fs.ensureDirSync(join(abDirPath, "blind", "scores"));
    fs.ensureDirSync(join(abDirPath, "blind", "scores-d"));
    const mapping = [
      { blindId: "item-01", arm: "control", ordinal: 1, matchId: "item-01" },
      { blindId: "item-02", arm: "treatment", ordinal: 1, matchId: "item-02" },
    ];
    fs.writeJsonSync(join(abDirPath, "blind", "mapping.json"), { mapping });
    writeScore(join(abDirPath, "blind", "scores"), "item-01", score(5));
    writeScore(join(abDirPath, "blind", "scores-d"), "item-01", score(3));
    writeScore(join(abDirPath, "blind", "scores"), "item-02", score(4));
    // item-02 的 D 判官分数缺失

    return computeFamilyStats(abDirPath).then((report) => {
      expect(report.pairs).toBe(0);
      expect(report.missingDJudge).toBe(1);
      expect(report.missingSJudge).toBe(0);
    });
  });
});
