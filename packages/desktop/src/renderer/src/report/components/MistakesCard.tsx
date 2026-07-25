import { useMemo, useState } from "react";

import type { Mistake, MistakeSeverity } from "../derive/mistakes";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const SEVERITY_CHIP: Record<MistakeSeverity, { cls: string; label: string }> = {
  major: { cls: "bad", label: "重大" },
  average: { cls: "warn", label: "一般" },
  minor: { cls: "dim", label: "轻微" },
};

/** 行数超过它时默认藏「轻微」档(chips 上保留计数,点开还原)。 */
const HIDE_MINOR_OVER = 12;

/**
 * 失误清单卡(第四阶段③ / backlog #8):确定性规则直出,不经 LLM。
 * 三档严重度 chips(WoWAnalyzer minor/average/major 模式)可过滤(P1-3,
 * 本地 state,时间轴 ⚠ 标记不受影响 —— 全场口径不变),逐条 ▶ 跳回放。
 */
export function MistakesCard({
  mistakes,
  onSeek,
}: {
  mistakes: Mistake[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<MistakeSeverity, number> = {
      major: 0,
      average: 0,
      minor: 0,
    };
    for (const m of mistakes) c[m.severity]++;
    return c;
  }, [mistakes]);
  // null = 全部(但长清单默认藏轻微);选中档 = 只看该档
  const [sel, setSel] = useState<MistakeSeverity | null>(null);
  const [showMinor, setShowMinor] = useState(
    mistakes.length <= HIDE_MINOR_OVER,
  );
  // 空数据保留卡壳(P1-1):0 失误是正向信号,不是空白
  if (mistakes.length === 0)
    return (
      <div className="rpt-ledger" data-testid="mistakes-card">
        <div className="rpt-ledger-head">
          <span className="rpt-ledger-title">失误清单</span>
        </div>
        <p className="rpt-ledger-empty">本场未检出失误 —— 干净局。</p>
      </div>
    );
  const visible = mistakes.filter((m) =>
    sel ? m.severity === sel : m.severity !== "minor" || showMinor,
  );
  const hiddenMinor = !sel && !showMinor ? counts.minor : 0;
  return (
    <div className="rpt-ledger" data-testid="mistakes-card">
      <div className="rpt-ledger-head">
        <span className="rpt-ledger-title">失误清单</span>
        <div className="rpt-ledger-tabs rpt-mistakes-filter">
          <button
            className={sel === null ? "active" : ""}
            onClick={() => setSel(null)}
          >
            全部 {mistakes.length}
          </button>
          {(Object.keys(SEVERITY_CHIP) as MistakeSeverity[]).map((s) => (
            <button
              key={s}
              className={sel === s ? "active" : ""}
              onClick={() => setSel((cur) => (cur === s ? null : s))}
            >
              {SEVERITY_CHIP[s].label} {counts[s]}
            </button>
          ))}
        </div>
        <span className="rpt-stats-dim">确定性规则直出</span>
      </div>
      {visible.map((mk, i) => {
        const chip = SEVERITY_CHIP[mk.severity];
        return (
          <div key={i} className="rpt-ledger-row">
            <span className="rpt-stats-detail-t">
              {mk.tS > 0 ? fmtT(mk.tS) : "全场"}
            </span>
            <span className={`rpt-ledger-chip rpt-ledger-chip-${chip.cls}`}>
              {chip.label}
            </span>
            <span>
              {mk.unitName.split("-")[0]} · {mk.label}
            </span>
            {mk.detail && <span className="rpt-stats-dim">{mk.detail}</span>}
            {onSeek && mk.tS > 0 && (
              <button
                className="rpt-stats-detail-jump"
                title="回放此刻"
                onClick={() => onSeek(Math.max(0, mk.tS - 3), mk.seekNames)}
              >
                ▶
              </button>
            )}
          </div>
        );
      })}
      {hiddenMinor > 0 && (
        <button
          className="rpt-ledger-empty rpt-mistakes-showminor"
          onClick={() => setShowMinor(true)}
        >
          +{hiddenMinor} 条轻微失误已折叠 —— 点击展开
        </button>
      )}
    </div>
  );
}
