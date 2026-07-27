import { ensureAnalysisData, type Finding } from "@gladlog/analysis";

import { bridge } from "../bridge";
import {
  buildAnalysisInput,
  buildDeepenPacks,
} from "../report/derive/analysisInput";
import type { ReportSource } from "../report/derive/types";

/** 批量队列里的一项(UI 侧从 meta 列表算好,驱动器不认识 meta)。 */
export type BatchItem = { id: string; label: string };

export type BatchStatus = {
  running: boolean;
  total: number;
  /** 已处理场数(含跳过/失败)。 */
  done: number;
  ok: number;
  skipped: number;
  failed: number;
  currentLabel: string | null;
  cancelled: boolean;
  /** 最近一轮批量的结束时刻(完成小结的显隐依据);跑新一轮时清空。 */
  finishedAt: number | null;
};

type CachedResult = {
  findings: Finding[];
  hadNarration: boolean;
  deepened?: boolean;
} | null;

const status: BatchStatus = {
  running: false,
  total: 0,
  done: 0,
  ok: 0,
  skipped: 0,
  failed: 0,
  currentLabel: null,
  cancelled: false,
  finishedAt: null,
};

/** 当前在飞的分析单元 id(定点取消用);场与场之间为 null。 */
let currentMid: string | null = null;

const subscribers = new Set<() => void>();
const notify = () => {
  // 订阅者是 React setState:快照浅拷贝,别把可变单例递出去
  for (const cb of subscribers) cb();
};

export function getBatchStatus(): BatchStatus {
  return { ...status };
}

export function subscribeBatch(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function cancelBatch(): void {
  if (!status.running) return;
  status.cancelled = true;
  // 定点取消当前在飞的那一场(main 侧按代际判过期,run invoke 就地
  // resolve,循环随后看到 cancelled 退出)。绝不能无参全局 cancel ——
  // 会把用户手动在跑的别场分析一并 abort(agy flash 复核 F1)。
  if (currentMid !== null) {
    try {
      void bridge().analysis.cancel(currentMid);
    } catch {
      /* 测试桩无该面 */
    }
  }
  notify();
}

/** 完成小结的关闭要落在单例上:放组件 state 的话切视图重挂会再弹一次。 */
export function dismissBatchSummary(): void {
  status.finishedAt = null;
  notify();
}

/**
 * 单个 source(整场 match 或 shuffle 的一个回合)走完整单盘管线:
 * getState 查缓存/在跑 → buildAnalysisInput → run → 查缓存拿结果 → 深挖。
 * 与手动点「AI 分析」的产出完全一致(共享 analysisInput.ts 的构建谓词,
 * main 侧同一 run/deepen 服务、同一落盘缓存)。
 */
async function processSource(
  source: ReportSource,
  matchId: string,
): Promise<"ok" | "skipped" | "failed"> {
  const ai = bridge().analysis;
  const { cached, running } = (await ai.getState(matchId)) as {
    cached: CachedResult;
    running: boolean;
  };
  // 已有缓存或别处正在跑(用户手动点了)都不重复烧 token
  if (cached || running) return "skipped";

  const input = buildAnalysisInput(source, matchId);
  if (!input) return "failed";
  currentMid = matchId;
  try {
    // invoke 在整轮跑完(含落盘 + emit done)后才 resolve
    await ai.run(input);
  } catch {
    return "failed";
  }
  if (status.cancelled) return "failed";
  const result = (await ai.getCached(matchId)) as CachedResult;
  // 无缓存 = 错误路径或被取消,run 已 emit error,这里只计数
  if (!result) return "failed";

  // 深挖轮:与 panel 的触发条件一致(有解说、有 finding、未深挖过)
  if (result.hadNarration && result.findings.length > 0 && !result.deepened) {
    const packs = buildDeepenPacks(
      source,
      result.findings,
      input.candidates,
      input.ownerName,
    );
    try {
      await ai.deepen({
        matchId,
        findings: result.findings,
        packs,
        spec: input.spec,
        ownerName: input.ownerName,
      });
    } catch {
      /* 深挖失败不致命,保持初轮 */
    }
  }
  return "ok";
}

/**
 * 批量分析:串行逐场跑(一次只一路 LLM 在飞 —— 本地 CLI 后端并发会互踩,
 * API 后端也躲开限流)。shuffle 一盘 = 逐回合,与手动逐回合点开一致。
 * 模块级单例:视图切换不中断;重复 start 直接忽略。
 */
export async function startBatch(items: BatchItem[]): Promise<void> {
  if (status.running || items.length === 0) return;
  status.running = true;
  status.total = items.length;
  status.done = 0;
  status.ok = 0;
  status.skipped = 0;
  status.failed = 0;
  status.cancelled = false;
  status.finishedAt = null;
  status.currentLabel = null;
  notify();

  try {
    // 提示词法术名不许降级:候选构建前表必须就绪(契约见 analysis/data/ensure.ts)
    await ensureAnalysisData();
    for (const item of items) {
      if (status.cancelled) break;
      status.currentLabel = item.label;
      notify();

      type MatchDoc = { kind?: string; data?: unknown };
      let doc: MatchDoc | null = null;
      try {
        doc = (await bridge().matches.get(item.id)) as MatchDoc | null;
      } catch {
        doc = null;
      }
      if (!doc?.data) {
        status.failed++;
        status.done++;
        continue;
      }

      // shuffle 的分析单元是回合(round.id 即缓存键);整场 match 单元是自身
      const units: Array<{ source: ReportSource; mid: string }> =
        doc.kind === "shuffle"
          ? (
              (doc.data as { rounds?: Array<ReportSource & { id: string }> })
                .rounds ?? []
            ).map((r) => ({ source: r, mid: r.id }))
          : [{ source: doc.data as ReportSource, mid: item.id }];

      let anyOk = false;
      let anyFailed = false;
      for (const u of units) {
        if (status.cancelled) break;
        let r: "ok" | "skipped" | "failed";
        try {
          r = await processSource(u.source, u.mid);
        } catch {
          // IPC 层意外 reject 只废这一个单元,不炸整个批次(agy flash 复核 F3)
          r = "failed";
        } finally {
          currentMid = null;
        }
        if (r === "ok") anyOk = true;
        else if (r === "failed") anyFailed = true;
      }
      if (status.cancelled && !anyOk && !anyFailed) break;
      if (anyFailed) status.failed++;
      else if (anyOk) status.ok++;
      else status.skipped++;
      status.done++;
      notify();
    }
  } finally {
    status.running = false;
    status.currentLabel = null;
    status.finishedAt = Date.now();
    notify();
  }
}
