import type { CandidateEvent } from "@gladlog/analysis";
// 预热 deepDive:生产代码在 deepenInner 里按需 await import(main 不再启动
// 即载 spellNames 12MB)。测试必须把这 12MB 的加载留在 collect 阶段 ——
// 否则首个 deepen 用例要在 5s 超时预算内付一次表加载,CI 慢机实锤超时
// (run 30193881051:本地绿、CI 双挂)。
import "@gladlog/analysis/src/analysis/deepDive";
import { describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { PROMPT_VERSION } from "./ai";
import { findingKey } from "../shared/findingKey";
import { createAnalysisService } from "./analysis";

const candidates: CandidateEvent[] = [
  {
    id: "death:a:30",
    type: "death",
    t: 30,
    unitNames: ["Me-R"],
    facts: { t: "30", unit: "Me-R" },
  },
];
function svc(streamText: string, apiKey: string | null = "k") {
  const emitted: Array<{ ch: string; p: any }> = [];
  const s = createAnalysisService({
    getSettings: () => ({
      anthropicApiKey: apiKey,
      wowDirectory: null,
    }),
    clientFactory: () => ({
      async *stream() {
        yield { delta: streamText };
      },
    }),
    matchesDir: "/tmp/nope-" + Math.random(),
    emit: (ch, p) => emitted.push({ ch, p }),
  });
  return { s, emitted };
}
const input = {
  matchId: "m1",
  candidates,
  richContext: "ctx",
  spec: "Discipline Priest",
};

describe("createAnalysisService", () => {
  it("audits LLM JSON findings and returns interpolated survivors", async () => {
    const { s, emitted } = svc(
      JSON.stringify([
        {
          eventIds: ["death:a:30"],
          severity: "high",
          category: "survival",
          title: "Death",
          explanation: "You died at {{t}}s.",
        },
      ]),
    );
    await s.run(input);
    const done = emitted.find((e) => e.ch === "gladlog:analysis:done")!;
    expect(done.p.result.findings[0].explanation).toBe("You died at 30s.");
    expect(done.p.result.hadNarration).toBe(true);
  });
  it("invalid JSON → deterministic fallback, no error", async () => {
    const { s, emitted } = svc("not json at all");
    await s.run(input);
    const done = emitted.find((e) => e.ch === "gladlog:analysis:done")!;
    expect(done.p.result.hadNarration).toBe(false);
    expect(
      emitted.find((e) => e.ch === "gladlog:analysis:error"),
    ).toBeUndefined();
  });
  it("no API key → deterministic fallback, no error", async () => {
    const { s, emitted } = svc("unused", null);
    await s.run(input);
    const done = emitted.find((e) => e.ch === "gladlog:analysis:done")!;
    expect(done.p.result.hadNarration).toBe(false);
  });
});

describe("isRunning 追踪(切页防丢 + 泄漏回归)", () => {
  it("完成后清除 running", async () => {
    const { s } = svc(JSON.stringify([]));
    await s.run(input);
    expect(await s.isRunning("m1")).toBe(false);
  });

  // 复审发现的泄漏:run 被 deepen(++同一 matchId 代际)取代时,旧实现的 abort
  // 路径不清 running(且清理判据是「代际是否最新」,deepen 后必假)→ running 永久
  // 残留 → 换到无缓存语言时卡「分析中…」。修:running 存代际、按主人身份清、abort 也清。
  it("run 被 deepen 取代后 running 不泄漏", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
      }),
      clientFactory: () => ({
        async *stream() {
          yield { delta: JSON.stringify([]) };
          await gate; // 挂住:模拟首轮还在跑
        },
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
    });
    const runP = s.run(input); // 加 running,产首 delta 后停在 gate
    await new Promise((r) => setTimeout(r, 0)); // 让 for-await 停到 gate
    expect(await s.isRunning("m1")).toBe(true);
    // packs 空 → deepen 只 ++代际即返回(不流式),恰好模拟「深挖取代在跑的 run」
    await s.deepen({ matchId: "m1", findings: [], packs: [], spec: "x" });
    release(); // run 恢复 → isCurrent 假 → abort → clearRunning
    await runP;
    expect(await s.isRunning("m1")).toBe(false); // 旧实现此处残留 true
  });
});

describe("AI 语言(backlog #1)", () => {
  const finding = JSON.stringify([
    {
      eventIds: ["death:a:30"],
      severity: "high",
      category: "survival",
      title: "Death",
      explanation: "You died at {{t}}s.",
    },
  ]);

  function langSvc(lang: "zh" | "en" | undefined, dir: string) {
    const captured: Array<{ system?: string }> = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
        aiLanguage: lang,
      }),
      clientFactory: () => ({
        async *stream(params: { system?: string }) {
          captured.push({ system: params.system });
          yield { delta: finding };
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    return { s, captured };
  }

  it("system prompt 按语言注入;缓存分键 analysis-v2.<lang>.json,互不命中", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { existsSync } = await import("fs");
    const dir = mkdtempSync(join(tmpdir(), "gl-ai-lang-"));

    const zh = langSvc("zh", dir);
    await zh.s.run(input);
    expect(zh.captured[0]!.system).toContain("Simplified Chinese");
    expect(existsSync(join(dir, "m1", "analysis-v2.zh.json"))).toBe(true);
    expect(await zh.s.getCached("m1")).not.toBeNull();

    // 同目录换英文:zh 缓存不可见(未命中),生成后写 en 键
    const en = langSvc("en", dir);
    expect(await en.s.getCached("m1")).toBeNull();
    await en.s.run(input);
    expect(en.captured[0]!.system).toContain("Respond in English");
    expect(en.captured[0]!.system).not.toContain("Simplified Chinese");
    expect(existsSync(join(dir, "m1", "analysis-v2.en.json"))).toBe(true);
    expect(await en.s.getCached("m1")).not.toBeNull();
    // zh 键仍在,切回 zh 直接命中
    expect(await zh.s.getCached("m1")).not.toBeNull();
  });

  it("旧缓存(无语言键)只在请求英文时兜底命中;缺省语言为 zh", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "gl-ai-legacy-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    writeFileSync(
      join(dir, "m1", "analysis-v2.json"),
      JSON.stringify({
        schemaVersion: 1,
        promptVersion: PROMPT_VERSION,
        createdAt: 1,
        result: { findings: [], dropped: 0, hadNarration: false },
      }),
    );
    const en = langSvc("en", dir);
    expect(await en.s.getCached("m1")).not.toBeNull();
    const zhDefault = langSvc(undefined, dir); // 缺省 → zh
    expect(await zhDefault.s.getCached("m1")).toBeNull();
  });
});

describe("finding 标记(phase3 #3a)", () => {
  it("setFlag 落盘、覆盖、清除;getFlags 缺文件回空", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "gl-flags-"));
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
      }),
      matchesDir: dir,
      emit: () => {},
    });
    expect(await s.getFlags("m1")).toEqual({});
    await s.setFlag("m1", "survival|e1,e2", "done");
    expect(await s.getFlags("m1")).toEqual({ "survival|e1,e2": "done" });
    await s.setFlag("m1", "survival|e1,e2", "recurring");
    await s.setFlag("m1", "cd|e3", "done");
    expect(await s.getFlags("m1")).toEqual({
      "survival|e1,e2": "recurring",
      "cd|e3": "done",
    });
    await s.setFlag("m1", "cd|e3", null);
    expect(await s.getFlags("m1")).toEqual({ "survival|e1,e2": "recurring" });
  });
});

describe("跨场聚合(phase3 #3b)", () => {
  it("按 category 计数、双语言只计一份、flag 统计、recent 按时间", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "gl-agg-"));
    const doc = (createdAt: number, findings: unknown[]) =>
      JSON.stringify({
        schemaVersion: 1,
        promptVersion: PROMPT_VERSION,
        createdAt,
        result: { findings, dropped: 0, hadNarration: true },
      });
    const f = (category: string, title: string, ids: string[]) => ({
      category,
      title,
      severity: "high",
      eventIds: ids,
      explanation: "",
    });
    // m1:zh + en 双缓存(只应计一次);m2:仅 en;m1 有 recurring 标记
    mkdirSync(join(dir, "m1"));
    writeFileSync(
      join(dir, "m1", "analysis-v2.zh.json"),
      doc(200, [f("survival", "死亡A", ["e1"]), f("cd", "CD浪费", ["e2"])]),
    );
    writeFileSync(
      join(dir, "m1", "analysis-v2.en.json"),
      doc(200, [f("survival", "DeathA", ["e1"])]),
    );
    writeFileSync(
      join(dir, "m1", "findingFlags.json"),
      JSON.stringify({ "survival|e1": "recurring" }),
    );
    writeFileSync(
      join(dir, "m1", "meta.json"),
      JSON.stringify({ id: "m1-real" }),
    );
    mkdirSync(join(dir, "m2"));
    writeFileSync(
      join(dir, "m2", "analysis-v2.en.json"),
      doc(100, [f("survival", "DeathB", ["e9"])]),
    );

    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
        aiLanguage: "zh",
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const agg = await s.aggregate();
    const survival = agg.find((a) => a.category === "survival")!;
    // m1 取 zh 一份(1 条 survival)+ m2 en 兜底(1 条)= 2
    expect(survival.count).toBe(2);
    expect(survival.recurring).toBe(1);
    // recent 按 createdAt 降序,最新的是 m1(200),meta.json 的真实 id 生效
    expect(survival.recent[0]!.matchId).toBe("m1-real");
    expect(survival.recent[0]!.title).toBe("死亡A");
    // 聚合键走归一(枚举化):历史 "cd" 形态并进 cooldowns 组
    expect(agg.find((a) => a.category === "cooldowns")!.count).toBe(1);
    expect(agg.find((a) => a.category === "cd")).toBeUndefined();
  });
});

describe("定点取消(批量取消不误伤手动分析)", () => {
  it("cancel(matchId) 只 abort 该场在飞的 run,别场照常完成", async () => {
    const gates = new Map<string, () => void>();
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
      }),
      clientFactory: () => ({
        async *stream() {
          yield { delta: JSON.stringify([]) };
          await new Promise<void>((r) => {
            // 每路流各自挂住,靠 gate 逐一放行
            gates.set(gates.has("g1") ? "g2" : "g1", r);
          });
          yield { delta: "" };
        },
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
    });
    const p1 = s.run({ ...input, matchId: "m1" });
    const p2 = s.run({ ...input, matchId: "m2" });
    await new Promise((r) => setTimeout(r, 0)); // 两路流都停到 gate
    expect(await s.isRunning("m1")).toBe(true);
    expect(await s.isRunning("m2")).toBe(true);

    await s.cancel("m1"); // 定点:只作废 m1
    expect(await s.isRunning("m1")).toBe(false);
    expect(await s.isRunning("m2")).toBe(true); // 别场不受伤
    gates.get("g1")!();
    gates.get("g2")!();
    await Promise.all([p1, p2]);
    expect(await s.isRunning("m2")).toBe(false); // m2 正常跑完
  });
});

describe("listAnalyzed(批量分析的跳过谓词)", () => {
  it("命中谓词与 getCached 一致:当前语言有效缓存才算;id 走 meta.json 兜底目录名", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "gl-la-"));
    const doc = (promptVersion: number) =>
      JSON.stringify({
        schemaVersion: 1,
        promptVersion,
        createdAt: 1,
        result: { findings: [], dropped: 0, hadNarration: true },
      });
    // m1:zh 有效缓存 + meta.json 真实 id → 计入,id 取 meta 的
    mkdirSync(join(dir, "m1"));
    writeFileSync(join(dir, "m1", "analysis-v2.zh.json"), doc(PROMPT_VERSION));
    writeFileSync(
      join(dir, "m1", "meta.json"),
      JSON.stringify({ id: "m1-real" }),
    );
    // m2:promptVersion 过期 → 不计(等价 getCached 未命中,批量会重跑)
    mkdirSync(join(dir, "m2"));
    writeFileSync(
      join(dir, "m2", "analysis-v2.zh.json"),
      doc(PROMPT_VERSION - 1),
    );
    // m3:仅 en 缓存而当前语言 zh → 不计(zh 面板也看不到这份缓存)
    mkdirSync(join(dir, "m3"));
    writeFileSync(join(dir, "m3", "analysis-v2.en.json"), doc(PROMPT_VERSION));
    // m4:无 meta.json 的有效缓存(shuffle 非首回合)→ 计入,目录名兜底
    mkdirSync(join(dir, "m4"));
    writeFileSync(join(dir, "m4", "analysis-v2.zh.json"), doc(PROMPT_VERSION));

    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
        aiLanguage: "zh",
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const ids = await s.listAnalyzed();
    expect(ids.sort()).toEqual(["m1-real", "m4"]);
  });

  it("matchesDir 不存在 → 空数组", async () => {
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
        aiLanguage: "zh",
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
    });
    expect(await s.listAnalyzed()).toEqual([]);
  });
});

describe("fallbackReason(0 finding 可解释)", () => {
  it("无候选 → no-candidates", async () => {
    const { s: svc1, emitted } = svc("unused");
    await svc1.run({ ...input, candidates: [] });
    const done = emitted.find((e) => e.ch === "gladlog:analysis:done")!;
    expect(done.p.result.fallbackReason).toBe("no-candidates");
  });
  it("无 client → no-client;坏 JSON → bad-json", async () => {
    const a = svc("unused", null);
    await a.s.run(input);
    expect(
      a.emitted.find((e) => e.ch === "gladlog:analysis:done")!.p.result
        .fallbackReason,
    ).toBe("no-client");
    const b = svc("not json at all");
    await b.s.run(input);
    expect(
      b.emitted.find((e) => e.ch === "gladlog:analysis:done")!.p.result
        .fallbackReason,
    ).toBe("bad-json");
  });
});

describe("onFindings(学习台账写入点)", () => {
  it("审计成功 → 回调,matchId 与 candidates 原样带出", async () => {
    const events: Array<{
      matchId: string;
      findings: unknown[];
      candidates: unknown[];
    }> = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
      }),
      clientFactory: () => ({
        async *stream() {
          yield {
            delta: JSON.stringify([
              {
                eventIds: ["death:a:30"],
                severity: "high",
                category: "survival",
                title: "Death",
                explanation: "You died at {{t}}s.",
              },
            ]),
          };
        },
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
      onFindings: (e) => events.push(e),
    });
    await s.run(input);
    expect(events).toHaveLength(1);
    expect(events[0]!.matchId).toBe("m1");
    expect(events[0]!.candidates).toBe(input.candidates);
    expect(events[0]!.findings).toHaveLength(1);
  });

  it("no-candidates → 记录(0 findings 进频次分母)", async () => {
    const events: Array<{ matchId: string; findings: unknown[] }> = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
      onFindings: (e) => events.push(e),
    });
    await s.run({ ...input, candidates: [] });
    expect(events).toHaveLength(1);
    expect(events[0]!.matchId).toBe("m1");
    expect(events[0]!.findings).toEqual([]);
  });

  it("no-client → 不记录(没分析就没记忆)", async () => {
    const events: unknown[] = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
      onFindings: (e) => events.push(e),
    });
    await s.run(input);
    expect(events).toHaveLength(0);
  });

  it("bad-json → 不记录", async () => {
    const events: unknown[] = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
      }),
      clientFactory: () => ({
        async *stream() {
          yield { delta: "not json at all" };
        },
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: () => {},
      onFindings: (e) => events.push(e),
    });
    await s.run(input);
    expect(events).toHaveLength(0);
  });

  it("onFindings 同步抛错(no-candidates 路径)不污染主流程:done 照发、无 error、Promise 不 reject", async () => {
    const emitted: Array<{ ch: string; p: any }> = [];
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: null,
        wowDirectory: null,
      }),
      matchesDir: "/tmp/nope-" + Math.random(),
      emit: (ch, p) => emitted.push({ ch, p }),
      onFindings: () => {
        throw new Error("ledger write boom");
      },
    });
    await expect(s.run({ ...input, candidates: [] })).resolves.toBeUndefined();
    const done = emitted.find((e) => e.ch === "gladlog:analysis:done");
    expect(done).toBeDefined();
    expect(done!.p.result.fallbackReason).toBe("no-candidates");
    expect(
      emitted.find((e) => e.ch === "gladlog:analysis:error"),
    ).toBeUndefined();
  });
});

describe("notebook(错题本跨场分组)", () => {
  it("按 category 分组、并入 meta 与标记、组内时间倒序", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = mkdtempSync(join(tmpdir(), "gl-nb-"));

    const writeMatch = (
      id: string,
      startTime: number,
      findings: Array<{
        eventIds: string[];
        severity: string;
        category: string;
        title: string;
        explanation: string;
      }>,
      flags?: Record<string, string>,
    ) => {
      const base = join(dir, id);
      mkdirSync(base, { recursive: true });
      writeFileSync(
        join(base, "analysis-v2.zh.json"),
        JSON.stringify({
          schemaVersion: 1,
          promptVersion: PROMPT_VERSION,
          language: "zh",
          createdAt: startTime,
          result: { findings, dropped: 0, hadNarration: true },
        }),
      );
      writeFileSync(
        join(base, "meta.json"),
        JSON.stringify({
          id,
          startTime,
          zoneId: "1505",
          result: "Win",
          bracket: "3v3",
        }),
      );
      if (flags)
        writeFileSync(join(base, "findingFlags.json"), JSON.stringify(flags));
    };

    const f = (category: string, title: string, ev: string) => ({
      eventIds: [ev],
      severity: "high",
      category,
      title,
      explanation: "x",
    });
    writeMatch("old", 1000, [f("生存", "早的", "e1")]);
    writeMatch(
      "new",
      2000,
      [f("生存", "晚的", "e2"), f("打断", "另一类", "e3")],
      {
        [findingKey(f("生存", "晚的", "e2"))]: "recurring",
      },
    );

    const s2 = createAnalysisService({
      getSettings: () => ({ aiLanguage: "zh" }) as never,
      matchesDir: dir,
      clientFactory: () => null as never,
      emit: () => {},
    });
    const nb = await s2.notebook();
    expect(nb.map((g) => g.category)).toEqual(["生存", "打断"]); // 按 count 降序
    const surv = nb[0]!;
    expect(surv.count).toBe(2);
    expect(surv.recurring).toBe(1);
    expect(surv.entries.map((e) => e.title)).toEqual(["晚的", "早的"]); // 时间倒序
    expect(surv.entries[0]).toMatchObject({
      matchId: "new",
      flag: "recurring",
      zoneId: "1505",
      result: "Win",
      bracket: "3v3",
      startTime: 2000,
    });
  });
});

describe("deepen(深挖轮)", () => {
  const pack = {
    findingIndex: 0,
    anchorFrom: 100,
    anchorTo: 150,
    items: [
      {
        key: "p1",
        kind: "cc" as const,
        t: 128,
        label: "Fear → Healer(4.0s)",
        unitNames: ["Healer-R"],
        facts: { t: "128", spell: "Fear", duration: "4.0" },
      },
    ],
    facts: { "p1.t": "128", "p1.spell": "Fear", "p1.duration": "4.0" },
  };
  const baseFindings = [
    {
      eventIds: ["death:v:150"],
      severity: "high",
      category: "survival",
      title: "被秒",
      explanation: "You died at 150s.",
    },
  ];

  it("合规深挖 → 合并进结果并再次 emit done;审不过 → 保持初轮", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const good = JSON.stringify([
      {
        findingIndex: 0,
        deepDive: "At {{p1.t}}s the healer ate {{p1.spell}}. Swap earlier.",
        citedKeys: ["p1"],
      },
    ]);
    const emitted: Array<{ ch: string; p: any }> = [];
    const svcDeep = (raw: string) =>
      createAnalysisService({
        getSettings: () => ({ anthropicApiKey: "k" }) as never,
        matchesDir: mkdtempSync(join(tmpdir(), "gl-deep-")),
        clientFactory: () =>
          ({
            stream: () =>
              (async function* () {
                yield { delta: raw };
              })(),
          }) as never,
        emit: (ch, p) => emitted.push({ ch, p }),
      });

    await svcDeep(good).deepen({
      matchId: "m1",
      findings: baseFindings as never,
      packs: [pack] as never,
      spec: "Frost Mage",
    });
    const done = emitted.filter((e) => e.ch === "gladlog:analysis:done").pop()!;
    expect(done.p.result.deepened).toBe(true);
    expect(done.p.result.findings[0].deepDive.text).toContain(
      "At 128s the healer ate Fear",
    );
    expect(done.p.result.findings[0].deepDive.chips[0].t).toBe(128);

    emitted.length = 0;
    const bad = JSON.stringify([
      {
        findingIndex: 0,
        deepDive: "The Fear caused your death at {{p1.t}}s.", // 因果断言
        citedKeys: ["p1"],
      },
    ]);
    await svcDeep(bad).deepen({
      matchId: "m1",
      findings: baseFindings as never,
      packs: [pack] as never,
      spec: "Frost Mage",
    });
    const done2 = emitted
      .filter((e) => e.ch === "gladlog:analysis:done")
      .pop()!;
    expect(done2.p.result.deepened).toBe(true);
    expect(done2.p.result.findings[0].deepDive).toBeUndefined();
  });

  it("无 client / 空 packs → 只落 deepened 标志,不调模型", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const emitted: Array<{ ch: string; p: any }> = [];
    const s2 = createAnalysisService({
      getSettings: () => ({}) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-deep2-")),
      clientFactory: () => null as never,
      emit: (ch, p) => emitted.push({ ch, p }),
    });
    await s2.deepen({
      matchId: "m1",
      findings: baseFindings as never,
      packs: [] as never,
      spec: "s",
    });
    const done = emitted.filter((e) => e.ch === "gladlog:analysis:done").pop()!;
    expect(done.p.result.deepened).toBe(true);
    expect(done.p.result.findings[0].deepDive).toBeUndefined();
  });
});

describe("deepen 幂等守卫(周度复核 P2#4)", () => {
  // 病根:renderer 的触发条件是缓存里 deepened 仍为 false,而该标志要等本轮
  // writeMerged 才落盘。深挖在飞的几十秒里切走再切回 → 面板重挂 → 再触发一次,
  // 白烧一轮 token(旧 gen 会被 nextGen 判过期 abort,但请求已经发出去了)。
  it("同一场深挖在飞时的重复调用被丢弃,模型只调一次", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const payload = JSON.stringify([
      {
        findingIndex: 0,
        deepDive: "At {{p1.t}}s the healer ate {{p1.spell}}. Swap earlier.",
        citedKeys: ["p1"],
      },
    ]);
    let streamCalls = 0;
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-deep-idem-")),
      clientFactory: () =>
        ({
          stream: () => {
            streamCalls++;
            return (async function* () {
              await inFlight; // 卡住 = 深挖在飞
              yield { delta: payload };
            })();
          },
        }) as never,
      emit: () => {},
    });
    const args = {
      matchId: "m1",
      findings: [
        {
          eventIds: ["death:v:150"],
          severity: "high",
          category: "survival",
          title: "被秒",
          explanation: "You died at 150s.",
        },
      ] as never,
      packs: [
        {
          findingIndex: 0,
          anchorFrom: 100,
          anchorTo: 150,
          items: [
            {
              key: "p1",
              kind: "cc" as const,
              t: 128,
              label: "Fear → Healer",
              unitNames: ["Healer-R"],
              facts: { t: "128", spell: "Fear" },
            },
          ],
          facts: { "p1.t": "128", "p1.spell": "Fear" },
        },
      ] as never,
      spec: "Frost Mage",
    };

    const first = s.deepen(args);
    // deepDive 模块在 deepenInner 里按需 await import(避免 main 启动即载
    // spellNames 12MB,见 analysis.ts),进流式比 deepen() 晚若干微任务 ——
    // 轮询到位;deepening 守卫本身仍在首个 await 前同步生效。
    await vi.waitFor(() => expect(streamCalls).toBe(1)); // 首轮已进流式
    await s.deepen(args); // 切页回来的重复触发
    expect(streamCalls).toBe(1); // 没有第二次模型调用
    release();
    await first;
    expect(streamCalls).toBe(1);

    // 守卫是「在飞期间」而非「永久」:本轮结束后仍可再深挖(用户手动重跑)
    release = () => {};
    await s.deepen(args);
    expect(streamCalls).toBe(2);
  });
});

describe("getState 原子查询(周度复核 P2#5)", () => {
  const mk = async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    return createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-getstate-")),
      clientFactory: () => null as never,
      emit: () => {},
    });
  };

  it("未跑过 → {cached:null, running:false}", async () => {
    const s = await mk();
    expect(await s.getState("m1")).toEqual({ cached: null, running: false });
  });

  it("在跑但还没落盘 → {cached:null, running:true}(面板显示「分析中…」)", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-getstate-run-")),
      clientFactory: () =>
        ({
          stream: () =>
            (async function* () {
              await inFlight;
              yield { delta: "[]" };
            })(),
        }) as never,
      emit: () => {},
    });
    const p = s.run({
      matchId: "m1",
      candidates: [{ id: "c1", type: "x", t: 1, unitNames: [], facts: {} }],
      richContext: "ctx",
      spec: "Frost Mage",
    } as never);
    const mid = await s.getState("m1");
    expect(mid).toEqual({ cached: null, running: true });
    release();
    await p;
  });

  it("跑完后 → cached 非空、running 已清(两次分开问时漏结果的那个缝)", async () => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-getstate-done-")),
      clientFactory: () =>
        ({
          stream: () =>
            (async function* () {
              yield { delta: "[]" };
            })(),
        }) as never,
      emit: () => {},
    });
    await s.run({
      matchId: "m1",
      candidates: [{ id: "c1", type: "x", t: 1, unitNames: [], facts: {} }],
      richContext: "ctx",
      spec: "Frost Mage",
    } as never);
    const after = await s.getState("m1");
    expect(after.running).toBe(false);
    expect(after.cached).not.toBeNull(); // 结果拿得到,不会停在空闲态
  });
});

describe("代际条目回收(周度复核 P3#9)", () => {
  const mkSvc = async (gen: () => AsyncGenerator<{ delta: string }>) => {
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    return createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-reap-")),
      clientFactory: () => ({ stream: () => gen() }) as never,
      emit: () => {},
    });
  };
  const input = (matchId: string) =>
    ({
      matchId,
      candidates: [{ id: "c1", type: "x", t: 1, unitNames: [], facts: {} }],
      richContext: "ctx",
      spec: "Frost Mage",
    }) as never;

  it("跑完即回收,不随看过的场次线性增长", async () => {
    const s = await mkSvc(async function* () {
      yield { delta: "[]" };
    });
    for (const id of ["m1", "m2", "m3"]) await s.run(input(id));
    // 三场都跑完 → 三条代际都该回收(经 getState 侧信道观察:全部回到初始态)
    for (const id of ["m1", "m2", "m3"])
      expect((await s.getState(id)).running).toBe(false);
    expect(s.__generationCount()).toBe(0);
  });

  it("deepen 收尾时不得回收同场在飞的 run —— 否则 run 把自己判成过期,分析凭空丢", async () => {
    // 这是守卫真正吃劲的场景:deepen 在飞 → 用户手点「AI 分析」→ 新 run 接管
    // (代际 ++,deepen 随即判过期退出)→ deepen 的 finally 回收代际条目。
    // 若无「无 run 在飞才回收」的判据,新 run 下一拍 isCurrent 就读到 undefined,
    // 把自己当成过期的中途 abort,缓存永不落盘。
    const { mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    let releaseDeep!: () => void;
    const deepInFlight = new Promise<void>((r) => (releaseDeep = r));
    let releaseRun!: () => void;
    const runInFlight = new Promise<void>((r) => (releaseRun = r));
    let call = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k" }) as never,
      matchesDir: mkdtempSync(join(tmpdir(), "gl-reap-race-")),
      clientFactory: () =>
        ({
          stream: () => {
            const mine = ++call;
            return (async function* () {
              await (mine === 1 ? deepInFlight : runInFlight);
              yield { delta: "[]" };
            })();
          },
        }) as never,
      emit: () => {},
    });

    const deep = s.deepen({
      matchId: "m1",
      findings: [] as never,
      packs: [
        {
          findingIndex: 0,
          anchorFrom: 0,
          anchorTo: 10,
          items: [
            {
              key: "p1",
              kind: "cc" as const,
              t: 5,
              label: "x",
              unitNames: [],
              facts: { t: "5" },
            },
          ],
          facts: { "p1.t": "5" },
        },
      ] as never,
      spec: "Frost Mage",
    });
    const run = s.run(input("m1")); // 新 run 接管,deepen 就此过期
    releaseDeep();
    await deep; // deepen 收尾 → finally → reapGeneration
    releaseRun();
    await run;
    // run 没被误 abort:结果落了盘
    expect((await s.getState("m1")).cached).not.toBeNull();
  });

  it("在飞期间不回收 —— 回收了会让这一轮把自己判成过期而中途 abort", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((r) => (release = r));
    const s = await mkSvc(async function* () {
      await inFlight;
      yield { delta: "[]" };
    });
    const p = s.run(input("m1"));
    expect(s.__generationCount()).toBe(1); // 在飞,必须留着
    release();
    await p;
    expect(s.__generationCount()).toBe(0); // 落地后回收
    expect((await s.getState("m1")).cached).not.toBeNull(); // 没被误 abort
  });
});

/**
 * 真实模型输出的形态回归。
 *
 * 现网 bug(2026-07-20 复现):`claude -p` 对 findings prompt 返回的是
 * ```json … ``` 围栏包裹的**完全合规**内容,而 main 侧 JSON.parse(raw.trim())
 * 零容错,于是整份好分析被判 bad-json、退成确定性展示。
 *
 * 旧测试只喂 "not json at all" 断言回退生效 —— 那验证的是回退机制本身,
 * 把「严格解析」编码成了正确行为,所以永远抓不到这类误杀。这里补的是
 * 反向断言:**本该被接受的真实输出必须活下来**。
 */
describe("模型输出形态容错(bad-json 误杀回归)", () => {
  const good = [
    {
      eventIds: ["death:a:30"],
      severity: "high",
      category: "survival",
      title: "阵亡",
      explanation: "你在 {{t}}s 倒下,考虑早一拍交减伤。",
    },
  ];
  const body = JSON.stringify(good, null, 2);

  const runWith = async (raw: string) => {
    const { s, emitted } = svc(raw);
    await s.run(input);
    return emitted.find((e) => e.ch === "gladlog:analysis:done")!.p.result;
  };

  it("```json 围栏(claude -p 实测形态)不该被判 bad-json", async () => {
    const r = await runWith("```json\n" + body + "\n```");
    expect(r.fallbackReason).toBeUndefined();
    expect(r.hadNarration).toBe(true);
    expect(r.findings).toHaveLength(1);
  });

  it("裸 ``` 围栏(无语言标注)同样要吃下", async () => {
    const r = await runWith("```\n" + body + "\n```");
    expect(r.fallbackReason).toBeUndefined();
    expect(r.findings).toHaveLength(1);
  });

  it("围栏外还有前后散文(system prompt 要求中文回复时常见)", async () => {
    const r = await runWith(
      "好的,以下是本场的教练要点:\n\n```json\n" +
        body +
        "\n```\n\n希望有帮助。",
    );
    expect(r.fallbackReason).toBeUndefined();
    expect(r.findings).toHaveLength(1);
  });

  it("真正的垃圾仍要回退 —— 容错不能把 bad-json 兜没了", async () => {
    expect((await runWith("not json at all")).fallbackReason).toBe("bad-json");
    expect((await runWith("")).fallbackReason).toBe("bad-json");
    // 截断的数组:救不回来就该老实回退,不能吐半份
    expect(
      (await runWith('```json\n[{"eventIds":["death:a:30"],"sev'))
        .fallbackReason,
    ).toBe("bad-json");
  });

  it("顶层是对象(非数组)仍判 bad-json —— 契约是数组", async () => {
    expect(
      (await runWith('```json\n{"findings":[]}\n```')).fallbackReason,
    ).toBe("bad-json");
  });
});

describe("analyzeWindow(#16 选段分析)", () => {
  const PACK = {
    findingIndex: 0,
    anchorFrom: 30,
    anchorTo: 60,
    items: [
      {
        key: "p1",
        kind: "cc" as const,
        t: 40,
        label: "Fear → O",
        unitNames: ["O-R"],
        facts: {
          t: "40",
          spell: "Fear",
          duration: "4.0",
          trinket: "available_unused",
        },
      },
    ],
    facts: {
      "p1.t": "40",
      "p1.spell": "Fear",
      "p1.duration": "4.0",
      "p1.trinket": "available_unused",
    },
  };
  const GOOD = JSON.stringify([
    {
      findingIndex: 0,
      deepDive:
        "At {{p1.t}}s the {{p1.spell}} landed with trinket {{p1.trinket}}; trinket that stun.",
      citedKeys: ["p1"],
    },
  ]);
  const input = (_dir: string) => ({
    matchId: "m1",
    fromS: 30,
    toS: 60,
    pack: PACK as never,
    kind: "survival" as const,
    spec: "Holy Paladin",
    ownerName: "O-Realm",
  });

  it("正常链路:LLM → 审计 → ok + 落盘;二次调用命中缓存不再调 client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir));
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") {
      expect(r1.text).toContain("At 40s");
      expect(r1.fromCache).toBe(false);
    }
    expect(
      JSON.parse(
        readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
      )["anthropic:claude-sonnet-5:30-60"].text,
    ).toContain("At 40s");
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") expect(r2.fromCache).toBe(true);
    expect(calls).toBe(1);
  });

  it("#21 item11(红→绿):审计全丢 → audit-empty 且缓存诚实空终态;二次调用命中缓存不再调 client", async () => {
    // client 吐裸数字条目("died at 40s" 无占位符)→ auditDeepDives 全丢
    // (bare-digit 禁令,镜像初轮纪律)。
    const dir = mkdtempSync(join(tmpdir(), "gl-win-audit-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    const BAD = JSON.stringify([
      {
        findingIndex: 0,
        deepDive: "The player died at 40s with no trinket up.",
        citedKeys: ["p1"],
      },
    ]);
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: BAD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir));
    expect(r1.status).toBe("audit-empty");
    // 修复前:这里 existsSync(...) 是 false(不落盘)—— 现在诚实空终态
    // 也落盘,同一个 windowKey(含 backend:model,与成功路径同一判据)。
    const cachePath = join(dir, "m1", "windowAnalysis.zh.json");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"))[
      "anthropic:claude-sonnet-5:30-60"
    ];
    expect(cached).toMatchObject({ status: "empty" });
    expect(cached.text).toBeUndefined(); // 空终态不该带上一份"假"回复文本

    // 二次调用命中缓存:不再打模型,直接回放同一个 audit-empty 形状。
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("audit-empty");
    expect(calls).toBe(1);
  });

  it("无 client → no-client,不写缓存", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-noclient-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: null, wowDirectory: null }),
      matchesDir: dir,
      emit: () => {},
    });
    const r = await s.analyzeWindow(input(dir));
    expect(r.status).toBe("no-client");
    expect(existsSync(join(dir, "m1", "windowAnalysis.zh.json"))).toBe(false);
  });

  it("LRU:第 21 个窗口写入后最旧 at 的条目被驱逐,文件恰 20 条", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-lru-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    // 用可控计数器代替真墙钟:真实 Date.now() 在紧凑循环里可能撞到同一
    // 毫秒,LRU 排序(按 at 升序)就会靠 Object.keys 的插入序兜底而非真正
    // 验证「按时间驱逐最旧」这条谓词。
    let now = 1000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      const s = createAnalysisService({
        getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
        clientFactory: () => ({
          stream: () =>
            (async function* () {
              yield { delta: GOOD };
            })(),
        }),
        matchesDir: dir,
        emit: () => {},
      });
      for (let i = 0; i < 21; i++) {
        const r = await s.analyzeWindow({
          matchId: "m1",
          fromS: i * 100,
          toS: i * 100 + 30,
          pack: PACK as never,
          kind: "survival",
          spec: "Holy Paladin",
        });
        expect(r.status).toBe("ok");
      }
      const cache = JSON.parse(
        readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
      );
      const keys = Object.keys(cache);
      expect(keys).toHaveLength(20);
      expect(cache["anthropic:claude-sonnet-5:0-30"]).toBeUndefined(); // 最旧(第 1 个)被驱逐
      expect(cache["anthropic:claude-sonnet-5:2000-2030"]).toBeDefined(); // 最新(第 21 个)在
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("幂等:同场同窗口在飞时第二次调用立即返回 busy,不叠加 client 调用", async () => {
    // client stream 挂在 never-resolve 的 promise 上,并发两次 analyzeWindow
    const dir = mkdtempSync(join(tmpdir(), "gl-win-busy-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    const never = new Promise<void>(() => {
      /* 永不 resolve:模拟仍在飞 */
    });
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            await never;
            yield { delta: GOOD }; // 永远到不了这里
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const p1 = s.analyzeWindow(input(dir)); // 悬空:本用例内不等它完成
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("busy");
    await vi.waitFor(() => expect(calls).toBe(1)); // 首轮已真正进入 stream()
    expect(calls).toBe(1); // 没有第二次模型调用
    void p1;
  });

  it("跨窗口并发:两个不同 windowKey 同场并发分析,先完成的一方不被后完成的一方覆盖(lost-update 修复)", async () => {
    // 幂等守卫只按 `${matchId}:${windowKey}` 序列化同一窗口,同场不同窗口
    // 仍会并发跑到写盘那一步:两边若各自拿着函数头读到的旧快照整份 stringify
    // 写回,晚写的会把早写的条目静默抹掉。修法是写盘前重新读一次最新文件、
    // 在最新快照上 upsert 自己这条 key —— 这里用两个可控 release 的 gate
    // 模拟"A 先完成落盘,B 后完成"的时序,断言 B 落盘后 A 的条目仍在。
    const dir = mkdtempSync(join(tmpdir(), "gl-win-race-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const gateB = new Promise<void>((r) => (releaseB = r));
    let call = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          const mine = ++call; // 1 = 先调用的那路(A),2 = 后调用的那路(B)
          return (async function* () {
            await (mine === 1 ? gateA : gateB);
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const pA = s.analyzeWindow({
      matchId: "m1",
      fromS: 30,
      toS: 60,
      pack: PACK as never,
      kind: "survival",
      spec: "Holy Paladin",
    });
    const pB = s.analyzeWindow({
      matchId: "m1",
      fromS: 200,
      toS: 230,
      pack: PACK as never,
      kind: "survival",
      spec: "Holy Paladin",
    });
    releaseA();
    const rA = await pA; // A 先完成、先落盘
    expect(rA.status).toBe("ok");
    releaseB();
    const rB = await pB; // B 后完成、后落盘
    expect(rB.status).toBe("ok");
    const cache = JSON.parse(
      readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
    );
    // 两条都在:B 的写回没有覆盖掉 A 先写入的条目
    expect(Object.keys(cache).sort()).toEqual([
      "anthropic:claude-sonnet-5:200-230",
      "anthropic:claude-sonnet-5:30-60",
    ]);
  });

  it("client.stream() 抛异常 → error(可重试),不落盘;随后同窗口再调用锁已释放(不是 busy)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-err-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let attempt = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          attempt++;
          if (attempt === 1) throw new Error("network boom"); // 同步抛出:client.stream() 本身失败
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir));
    expect(r1.status).toBe("error");
    expect(existsSync(join(dir, "m1", "windowAnalysis.zh.json"))).toBe(false);
    // 锁已释放:同窗口立即再调用不是 busy,能正常走通(而非停留在 busy)
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("ok");
  });

  // Important 审计修复回归(三条):版本戳 / 后端+模型判据 / 0.1s 键精度。
  it("版本戳:旧版本条目(promptVersion 不匹配)判 miss,重新调用 client 并用新版本戳覆盖落盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-ver-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    const path = join(dir, "m1", "windowAnalysis.zh.json");
    const key = "anthropic:claude-sonnet-5:30-60";
    writeFileSync(
      path,
      JSON.stringify({
        [key]: {
          fromS: 30,
          toS: 60,
          text: "STALE ANSWER FROM OLD PROMPT VERSION",
          chips: [],
          at: 1,
          promptVersion: PROMPT_VERSION - 1,
        },
      }),
      "utf-8",
    );
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r = await s.analyzeWindow(input(dir));
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.fromCache).toBe(false); // 版本不匹配 → miss,不是命中旧答案
      expect(r.text).toContain("At 40s");
    }
    expect(calls).toBe(1); // 真去调了 client,不是复用陈旧条目
    const stamped = JSON.parse(readFileSync(path, "utf-8"))[key];
    expect(stamped.promptVersion).toBe(PROMPT_VERSION); // 落盘覆盖成当前版本
    expect(stamped.text).toContain("At 40s");
  });

  it("模型切换:同后端换模型(判据 backend:model 的 model 段)→ miss,新旧两条各自独立命中,互不覆盖", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-model-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    let aiModels: Record<string, string> | undefined;
    const s = createAnalysisService({
      getSettings: () => ({
        anthropicApiKey: "k",
        wowDirectory: null,
        aiModels: aiModels as never,
      }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const r1 = await s.analyzeWindow(input(dir)); // 默认模型 claude-sonnet-5
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") expect(r1.fromCache).toBe(false);
    expect(calls).toBe(1);

    aiModels = { anthropic: "claude-opus-4-8" }; // 换模型,同后端同窗口
    const r2 = await s.analyzeWindow(input(dir));
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") expect(r2.fromCache).toBe(false); // 不是命中旧模型的答案
    expect(calls).toBe(2); // 真去调了 client 第二次

    const cache = JSON.parse(
      readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
    );
    expect(Object.keys(cache).sort()).toEqual([
      "anthropic:claude-opus-4-8:30-60",
      "anthropic:claude-sonnet-5:30-60",
    ]);

    // 换回旧模型 → 命中旧模型那条缓存,不再调 client
    aiModels = undefined;
    const r3 = await s.analyzeWindow(input(dir));
    expect(r3.status).toBe("ok");
    if (r3.status === "ok") expect(r3.fromCache).toBe(true);
    expect(calls).toBe(2);
  });

  it("0.1s 精度:相差 0.7s 的两次拖拽(30.1s vs 30.8s)落成两条独立缓存,不互相顶掉", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-win-precision-"));
    mkdirSync(join(dir, "m1"), { recursive: true });
    let calls = 0;
    const s = createAnalysisService({
      getSettings: () => ({ anthropicApiKey: "k", wowDirectory: null }),
      clientFactory: () => ({
        stream: () => {
          calls++;
          return (async function* () {
            yield { delta: GOOD };
          })();
        },
      }),
      matchesDir: dir,
      emit: () => {},
    });
    const mk = (fromS: number) => ({
      matchId: "m1",
      fromS,
      toS: 60,
      pack: PACK as never,
      kind: "survival" as const,
      spec: "Holy Paladin",
    });
    const r1 = await s.analyzeWindow(mk(30.1));
    expect(r1.status).toBe("ok");
    const r2 = await s.analyzeWindow(mk(30.8));
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") expect(r2.fromCache).toBe(false); // 不同窗口,不该命中
    expect(calls).toBe(2);
    const cache = JSON.parse(
      readFileSync(join(dir, "m1", "windowAnalysis.zh.json"), "utf-8"),
    );
    expect(Object.keys(cache).sort()).toEqual([
      "anthropic:claude-sonnet-5:30.1-60",
      "anthropic:claude-sonnet-5:30.8-60",
    ]);
    // 同一 0.1s 精度的窗口再次请求仍命中
    const r3 = await s.analyzeWindow(mk(30.1));
    if (r3.status === "ok") expect(r3.fromCache).toBe(true);
    expect(calls).toBe(2);
  });
});
