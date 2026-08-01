import { bridge } from "../bridge";
import {
  getBatchStatus,
  startBatch,
  subscribeBatch,
  type BatchItem,
} from "./batchAnalysis";
import type { StoredMatchMeta } from "../../../main/matchStore";

type LiveStoredMatchMeta = StoredMatchMeta & { live?: boolean };

/**
 * 自动分析新对局(2026-08-01,spec:
 * docs/superpowers/specs/2026-08-01-auto-analyze-design.md)。
 *
 * 模块级队列:一场新对局 = 一个 meta.id,去重后交给批量驱动器
 * (batchAnalysis.ts)——跳过已缓存/串行/自动深挖零新逻辑,自动分析与
 * 手动批量分析共享同一条管线。
 *
 * 判别铁律:只有 matchStored payload 的 live===true(main/index.ts 实时
 * 路径打标)才触发;导入路径(importLogs.ts)不带该字段,天然被挡在
 * handleMatchStored 的第一道判断外——导入洪峰绝不会喂进这条队列。
 */
const pending: string[] = [];
const pendingLabels = new Map<string, string>();

/** 忙时排队等待的退订句柄;非 null 表示已经在等一次 idle 通知,避免
 * 同一批 pending 被并发的多个 drain() 调用重复挂 subscribeBatch。 */
let waitingForIdle: (() => void) | null = null;

/** 与 BatchAnalyzeBar.labelFor 同风格;拿不到合法 startTime 就退化成 id 前八位。 */
function labelFor(meta: StoredMatchMeta): string {
  const d = new Date(meta.startTime);
  if (Number.isNaN(d.getTime())) return meta.id.slice(0, 8);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} · ${meta.bracket}`;
}

function drain(): void {
  if (pending.length === 0) return;
  if (getBatchStatus().running) {
    // 已经在跑批量(用户手动点了,或上一轮自动分析还没收尾):挂起等
    // 空闲再重试,不重复挂多个订阅。
    if (!waitingForIdle) {
      waitingForIdle = subscribeBatch(() => {
        if (getBatchStatus().running) return;
        waitingForIdle?.();
        waitingForIdle = null;
        drain();
      });
    }
    return;
  }
  const items: BatchItem[] = pending.splice(0).map((id) => ({
    id,
    label: pendingLabels.get(id) ?? id.slice(0, 8),
  }));
  for (const item of items) pendingLabels.delete(item.id);
  void startBatch(items);
}

function enqueue(meta: StoredMatchMeta): void {
  if (pending.includes(meta.id)) return; // 去重:同一场重复通知只排一次
  pending.push(meta.id);
  pendingLabels.set(meta.id, labelFor(meta));
  drain();
}

async function handleMatchStored(meta: LiveStoredMatchMeta): Promise<void> {
  if (!meta.live) return; // 判别铁律:导入路径没有 live,直接挡在这里
  let settings: { autoAnalyzeNew: boolean };
  try {
    settings = await bridge().settings.get();
  } catch {
    return; // 桩缺 settings 面(如部分测试台/fixture)
  }
  if (!settings.autoAnalyzeNew) return;
  enqueue(meta);
}

/**
 * App 挂载时调一次,返回退订函数。调用方(App.tsx)需要自行 try/catch —
 * 桩缺 logs 面时 bridge().logs.onMatchStored 本身可能直接抛。
 */
export function startAutoAnalyzeListener(): () => void {
  return bridge().logs.onMatchStored((meta) => {
    void handleMatchStored(meta as LiveStoredMatchMeta);
  });
}
