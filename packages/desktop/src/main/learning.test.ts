import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { AnthropicLike } from "./ai";
import { createLearningService } from "./learning";

/** 造一个 matches 目录:n 场,偶数场带 survival finding 的 analysis 缓存。 */
function seedMatches(root: string, n: number): string {
  const matchesDir = join(root, "matches");
  for (let i = 0; i < n; i++) {
    const dir = join(matchesDir, `m${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id: `m${i}`,
        startTime: 1_000_000 + i * 60_000,
        result: i % 3 === 0 ? "win" : "loss",
        zoneId: "1552",
        bracket: "3v3",
        teams: [[], [{ specId: 62, classId: 8 }]],
      }),
    );
    writeFileSync(
      join(dir, "analysis-v2.zh.json"),
      JSON.stringify({
        schemaVersion: 1,
        promptVersion: 7, // 故意用旧版本:回填必须不看 promptVersion
        language: "zh",
        createdAt: 1_000_000 + i * 60_000,
        result: {
          findings:
            i % 2 === 0
              ? [
                  {
                    eventIds: ["e1"],
                    severity: "high",
                    category: "survival",
                    title: "t",
                    explanation: "死于集火时没开减伤。",
                  },
                ]
              : [],
          dropped: 0,
          hadNarration: true,
        },
      }),
    );
  }
  return matchesDir;
}

const fakeClient = (raw: string): AnthropicLike => ({
  async *stream() {
    yield { delta: raw };
  },
});

const flush = () => new Promise((r) => setTimeout(r, 50));

function mkService(root: string, raw: string) {
  const events: Array<{ ch: string; payload: unknown }> = [];
  const svc = createLearningService({
    getSettings: () => ({
      anthropicApiKey: "k",
      aiModels: null,
      wowDirectory: null,
      aiLanguage: "zh" as const,
    }),
    clientFactory: () => fakeClient(raw),
    matchesDir: join(root, "matches"),
    learningDir: join(root, "learning"),
    emit: (ch, payload) => events.push({ ch, payload }),
  });
  return { svc, events };
}

describe("learning 服务", () => {
  it("回填:全部旧 promptVersion 场也进台账;完成写标记 + 首次整合", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn-"));
    seedMatches(root, 20);
    const good = JSON.stringify([
      {
        patternId: "cat:survival",
        description: "近 {{windowMatches}} 场里 {{hits}} 场有生存问题。",
        advice: "留意减伤时机。",
      },
    ]);
    const { svc } = mkService(root, good);
    svc.init();
    // 回填 + 首次整合都是异步;轮询标记文件
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const st = await svc.getState();
    expect(st.ledgerMatches).toBe(20);
    const doc = (await svc.getRules()) as RulesDoc;
    expect(doc).not.toBeNull();
    // 10/20 场命中 survival(偶数场),必产出 active 规则
    const r = doc.rules.find((x) => x.ruleId === "cat:survival");
    expect(r?.status).toBe("active");
    expect(r?.stats.hits).toBe(10);
    expect(r?.description.zh).toContain("{{hits}}");
  });

  it("提炼输出裸数字 → 审计丢弃,规则仍在但无文本;stats 照常落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn2-"));
    seedMatches(root, 20);
    const bad = JSON.stringify([
      { patternId: "cat:survival", description: "近 20 场 10 次", advice: "x" },
    ]);
    const { svc } = mkService(root, bad);
    svc.init();
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const doc = (await svc.getRules()) as RulesDoc;
    const r = doc.rules.find((x) => x.ruleId === "cat:survival")!;
    expect(r.stats.hits).toBe(10);
    expect(r.description.zh).toBeUndefined();
  });

  it("recordAnalysis:append 台账并带候选 type;自动整合按增量 10 场触发", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn3-"));
    const _matchesDir = seedMatches(root, 1);
    const { svc } = mkService(root, "[]");
    // 手工放回填标记,跳过回填路径
    mkdirSync(join(root, "learning"), { recursive: true });
    writeFileSync(
      join(root, "learning", "backfill-done.json"),
      JSON.stringify({ at: 1, scanned: 0 }),
    );
    svc.init();
    svc.recordAnalysis({
      matchId: "m0",
      findings: [
        {
          eventIds: ["e1"],
          severity: "high",
          category: "survival",
          title: "t",
          explanation: "x",
        },
      ],
      candidates: [
        { id: "e1", type: "death", t: 30, unitNames: ["A"], facts: {} },
      ],
    });
    await flush();
    const ledger = readFileSync(
      join(root, "learning", "ledger.ndjson"),
      "utf-8",
    );
    expect(ledger).toContain('"eventTypes":["death"]');
    expect(ledger).toContain('"enemySpecs":[62]');
  });

  it("AI 提炼抛错(401/429/超时同类):确定性 stats/status 仍落盘,done 事件带 distillError", async () => {
    const root = mkdtempSync(join(tmpdir(), "gl-learn4-"));
    seedMatches(root, 20);
    const throwingClient: AnthropicLike = {
      stream() {
        throw new Error("simulated 429 rate limit");
      },
    };
    const events: Array<{ ch: string; payload: unknown }> = [];
    const svc = createLearningService({
      getSettings: () => ({
        anthropicApiKey: "k",
        aiModels: null,
        wowDirectory: null,
        aiLanguage: "zh" as const,
      }),
      clientFactory: () => throwingClient,
      matchesDir: join(root, "matches"),
      learningDir: join(root, "learning"),
      emit: (ch, payload) => events.push({ ch, payload }),
    });
    svc.init();
    for (let i = 0; i < 100; i++) {
      await flush();
      const st = await svc.getState();
      if (!st.backfill?.running && !st.consolidating) break;
    }
    const doc = (await svc.getRules()) as RulesDoc;
    expect(doc).not.toBeNull();
    const r = doc.rules.find((x) => x.ruleId === "cat:survival");
    expect(r?.stats.hits).toBe(10);
    expect(r?.status).toBe("active");
    expect(r?.description.zh).toBeUndefined();
    const done = events.find((e) => e.ch === "gladlog:learning:done");
    expect(done).toBeDefined();
    expect((done?.payload as { distillError?: string }).distillError).toContain(
      "simulated 429",
    );
  });
});
