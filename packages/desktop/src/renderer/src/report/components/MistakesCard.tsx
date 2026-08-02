import { useMemo, useState } from "react";

import type { Mistake, MistakeSeverity } from "../derive/mistakes";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const SEVERITY_CHIP: Record<MistakeSeverity, { cls: string; label: string }> = {
  major: { cls: "bad", label: "重大" },
  average: { cls: "warn", label: "一般" },
  minor: { cls: "dim", label: "轻微" },
};

/** Above this row count the "minor" tier is hidden by default (the chips keep
 * their counts and one click brings it back). */
const HIDE_MINOR_OVER = 12;

/**
 * Mistake list card (phase 4 ③ / backlog #8): emitted straight from
 * deterministic rules, never through the LLM.
 * The three severity chips (the WoWAnalyzer minor/average/major pattern) act as
 * filters (P1-3, local state; the timeline's ⚠ markers are unaffected — the
 * whole-match criterion does not change), and each row's ▶ jumps to the replay.
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
  // null = all (though long lists hide minor by default); a selected tier =
  // show only that tier
  const [sel, setSel] = useState<MistakeSeverity | null>(null);
  const [showMinor, setShowMinor] = useState(
    mistakes.length <= HIDE_MINOR_OVER,
  );
  // Keep the card shell when empty (P1-1): zero mistakes is a POSITIVE signal,
  // not a blank
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
