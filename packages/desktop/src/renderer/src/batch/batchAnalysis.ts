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

/** 并发路数(2026-08-01 生产反馈「批量太慢」,由串行改并发)。3 路是本地
 * CLI 后端(claude -p 单场数分钟)提速与 API 后端限流/renderer 内存(每路
 * 独立持有一份 doc + legacy 放大副本)之间的折中。安全性依据:CLI 临时文件
 * 已按 pid+自增序号隔离(localAiBackends.ts),main 侧 run/deepen 按 matchId
 * 分代际分桶,多场并飞互不作废;shuffle 回合与跨场单元进同一条队列,回合
 * 也并行。 */
const BATCH_CONCURRENCY = 3;

/** 当前在飞的分析单元 id 集合(定点取消用);空闲时为空。 */
const inFlight = new Set<string>();

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
  // 逐个定点取消当前在飞的单元(main 侧按代际判过期,run invoke 就地
  // resolve,worker 随后看到 cancelled 退出)。绝不能无参全局 cancel ——
  // 会把用户手动在跑的别场分析一并 abort(agy flash 复核 F1)。
  for (const mid of inFlight) {
    try {
      void bridge().analysis.cancel(mid);
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
  inFlight.add(matchId);
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

/** 单个批量项(整场 match 或 shuffle 一盘)的记账:回合级并发后,同一项的
 * 单元可能分散在多个 worker 上,最后一个单元落地时才结算这一项。 */
type ItemState = {
  item: BatchItem;
  pendingUnits: number;
  anyOk: boolean;
  anyFailed: boolean;
  settled: boolean;
};

/**
 * 批量分析:单元级并发池(BATCH_CONCURRENCY 路同时在飞)。分析单元 =
 * 整场 match 或 shuffle 的一个回合,跨场与同场回合进同一条队列 —— 一场
 * shuffle 的多个回合也并行。与手动逐回合点开产出完全一致(共享
 * processSource 的单盘管线)。模块级单例:视图切换不中断;重复 start 直接
 * 忽略。进度口径不变:done/ok/skipped/failed 仍按**场**计。
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

  // 展示:在飞各场的标签(同场多回合只显示一次)
  const activeLabels = new Set<string>();
  const updateLabel = () => {
    status.currentLabel =
      activeLabels.size > 0 ? [...activeLabels].join(" / ") : null;
  };

  const settleItem = (st: ItemState) => {
    if (st.settled) return;
    st.settled = true;
    activeLabels.delete(st.item.label);
    updateLabel();
    if (st.anyFailed) status.failed++;
    else if (st.anyOk) status.ok++;
    else status.skipped++;
    status.done++;
    notify();
  };

  // 待处理单元队列 + 惰性逐场装载:match.json 中位几十 MB,绝不预载全部;
  // 队列吃空才装下一场,常驻内存最多「在飞单元 + 刚装载的一场」。
  type MatchDoc = { kind?: string; data?: unknown };
  const unitQueue: Array<{
    st: ItemState;
    source: ReportSource;
    mid: string;
  }> = [];
  let nextItem = 0;
  const touched: ItemState[] = [];

  const takeUnit = async (): Promise<(typeof unitQueue)[number] | null> => {
    for (;;) {
      const u = unitQueue.shift();
      if (u) return u;
      if (status.cancelled || nextItem >= items.length) return null;
      const item = items[nextItem++];
      let doc: MatchDoc | null = null;
      try {
        doc = (await bridge().matches.get(item.id)) as MatchDoc | null;
      } catch {
        doc = null;
      }
      const st: ItemState = {
        item,
        pendingUnits: 0,
        anyOk: false,
        anyFailed: false,
        settled: false,
      };
      touched.push(st);
      if (!doc?.data) {
        st.anyFailed = true;
        settleItem(st);
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
      if (units.length === 0) {
        settleItem(st); // 无单元(空 shuffle)= 无事可做,计 skipped
        continue;
      }
      st.pendingUnits = units.length;
      for (const u of units) unitQueue.push({ st, ...u });
    }
  };

  // 装载互斥:多个 worker 同时吃空队列时,同一场只装一次、单元不重复入队。
  // promise 链串行化 takeUnit;链上异常吞掉,防后续调用者拿到已 reject 的链。
  let loadChain: Promise<unknown> = Promise.resolve();
  const takeUnitLocked = (): Promise<(typeof unitQueue)[number] | null> => {
    const p = loadChain.then(takeUnit, takeUnit);
    loadChain = p.catch(() => null);
    return p;
  };

  const worker = async (): Promise<void> => {
    while (!status.cancelled) {
      const u = await takeUnitLocked();
      if (!u) return;
      activeLabels.add(u.st.item.label);
      updateLabel();
      notify();
      let r: "ok" | "skipped" | "failed";
      try {
        r = await processSource(u.source, u.mid);
      } catch {
        // IPC 层意外 reject 只废这一个单元,不炸整个批次(agy flash 复核 F3)
        r = "failed";
      } finally {
        inFlight.delete(u.mid);
      }
      if (r === "ok") u.st.anyOk = true;
      else if (r === "failed") u.st.anyFailed = true;
      if (--u.st.pendingUnits === 0) settleItem(u.st);
      else notify();
    }
  };

  try {
    // 提示词法术名不许降级:候选构建前表必须就绪(契约见 analysis/data/ensure.ts)
    await ensureAnalysisData();
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, () =>
        worker(),
      ),
    );
    // 取消收尾:动过工的场(有成败记录)按旧口径照常结算;没动过的不计。
    if (status.cancelled) {
      for (const st of touched) {
        if (!st.settled && (st.anyOk || st.anyFailed)) settleItem(st);
      }
    }
  } finally {
    inFlight.clear();
    status.running = false;
    status.currentLabel = null;
    status.finishedAt = Date.now();
    notify();
  }
}
