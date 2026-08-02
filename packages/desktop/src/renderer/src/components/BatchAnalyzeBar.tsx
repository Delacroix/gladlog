import { useEffect, useState } from "react";

import type { StoredMatchMeta } from "../../../main/matchStore";
import {
  cancelBatch,
  dismissBatchSummary,
  getBatchStatus,
  startBatch,
  subscribeBatch,
  type BatchStatus,
} from "../batch/batchAnalysis";
import { bridge } from "../bridge";

const labelFor = (m: StoredMatchMeta): string => {
  const d = new Date(m.startTime);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} · ${m.bracket}`;
};

/**
 * Entry point for batch AI analysis (top of the match-list sidebar). Pick N →
 * take the N newest un-analyzed matches and run the full single-match pipeline
 * concurrently on them (including the deep dive, BATCH_CONCURRENCY in flight at
 * once). The driver is a module singleton, so switching views does not
 * interrupt it; this component is only its display surface.
 */
export function BatchAnalyzeBar({ metas }: { metas: StoredMatchMeta[] }) {
  const [st, setSt] = useState<BatchStatus>(getBatchStatus);
  const [n, setN] = useState(10);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => subscribeBatch(() => setSt(getBatchStatus())), []);

  const start = async () => {
    setNote(null);
    let analyzed: Set<string>;
    try {
      analyzed = new Set(await bridge().analysis.listAnalyzed());
    } catch {
      analyzed = new Set();
    }
    // metas is always newest→oldest (both paging and store insertion maintain
    // descending startTime).
    // Shuffles are NOT pre-filtered by `analyzed`: their meta.id is the first
    // round's id, and a cached first round ≠ all rounds analyzed (agy flash
    // review F2 — having manually viewed R1 would skip the whole match and R2+
    // would never get their turn). Shuffles are handed to the driver, which
    // checks the cache round by round and counts the match as skipped only when
    // every round is cached.
    const items = metas
      .filter((m) => m.kind === "shuffle" || !analyzed.has(m.id))
      .slice(0, Math.max(1, n))
      .map((m) => ({ id: m.id, label: labelFor(m) }));
    if (items.length === 0) {
      setNote("没有未分析的对局");
      return;
    }
    void startBatch(items);
  };

  if (st.running) {
    return (
      <div className="batch-bar" data-testid="batch-bar">
        <span className="batch-progress">
          批量分析中 {st.done}/{st.total}
          {st.currentLabel ? ` · ${st.currentLabel}` : ""}
        </span>
        <button className="batch-cancel" onClick={() => cancelBatch()}>
          取消
        </button>
      </div>
    );
  }

  if (st.finishedAt) {
    return (
      <div className="batch-bar" data-testid="batch-bar">
        <span className="batch-summary">
          {st.cancelled ? "已取消:" : "批量完成:"}
          成功 {st.ok} · 跳过 {st.skipped} · 失败 {st.failed}
        </span>
        <button
          className="batch-dismiss"
          aria-label="关闭小结"
          onClick={() => dismissBatchSummary()}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="batch-bar" data-testid="batch-bar">
      <span
        className="batch-title"
        title="从最新往旧取未分析的对局,最多三路并行跑与手动一致的完整分析(含深挖);已分析的自动跳过"
      >
        批量 AI 分析
      </span>
      <label className="batch-n">
        最近
        <input
          type="number"
          min={1}
          max={999}
          value={n}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) setN(Math.floor(v));
          }}
        />
        场未分析
      </label>
      <button className="batch-start" onClick={() => void start()}>
        开始
      </button>
      {note && <span className="batch-note">{note}</span>}
    </div>
  );
}
