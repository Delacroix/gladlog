import { useMemo, useState } from "react";

import type { IKillWindowTargetEval } from "@gladlog/analysis";

import { classColor } from "../data/gameConstants";
import type { LedgerPlayer } from "../derive/burstLedger";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtDmg = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : `${Math.round(n / 1000)}k`;

function Chip({ kind, children }: { kind: string; children: React.ReactNode }) {
  return (
    <span className={`rpt-ledger-chip rpt-ledger-chip-${kind}`}>
      {children}
    </span>
  );
}

function SeekBtn({
  tS,
  unitName,
  onSeek,
}: {
  tS: number;
  unitName: string;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  if (!onSeek) return null;
  return (
    <button
      className="rpt-stats-detail-jump"
      title="回放此刻"
      onClick={() => onSeek(Math.max(0, tS - 3), [unitName])}
    >
      ▶
    </button>
  );
}

/**
 * Burst ledger card (DPS direction D1): paged by player, in three sections --
 * burst alignment (one row per major-cooldown use: target, HP change, the
 * mitigation or immunity it hit into, coordination, outcome), kill-window
 * target discipline (share of damage landing on the window's target), and
 * interrupt audit (landed / juked / missed). Every row's ▶ seeks the replay
 * (the same seek pipeline as findings).
 */
export function BurstLedgerCard({
  players,
  targetSelection,
  onSeek,
}: {
  players: LedgerPlayer[];
  /** Team-level kill-window target-selection verdicts (#10 T3), joined to the
   * target-discipline rows by windowFromSeconds; windows with no match (fewer
   * than 2 enemies, or shorter than 5s) render no chip. */
  targetSelection?: IKillWindowTargetEval[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  const defaultIdx = useMemo(
    () =>
      Math.max(
        0,
        players.findIndex((p) => !p.isHealer),
      ),
    [players],
  );
  const [idx, setIdx] = useState(defaultIdx);
  // windowFromSeconds -> target-selection verdict (team-level, joined to the
  // target-discipline rows).
  const targetEvalByFrom = useMemo(() => {
    const m = new Map<number, IKillWindowTargetEval>();
    for (const ev of targetSelection ?? []) m.set(ev.windowFromSeconds, ev);
    return m;
  }, [targetSelection]);
  // Keep the card shell on empty data (P1-1)
  if (players.length === 0)
    return (
      <div className="rpt-ledger" data-testid="burst-ledger">
        <div className="rpt-ledger-head">
          <span className="rpt-ledger-title">爆发账本</span>
        </div>
        <p className="rpt-ledger-empty">本场无爆发窗口数据。</p>
      </div>
    );
  const p = players[Math.min(idx, players.length - 1)];

  return (
    <div className="rpt-ledger" data-testid="burst-ledger">
      <div className="rpt-ledger-head">
        <span className="rpt-ledger-title">爆发账本</span>
        <div className="rpt-ledger-tabs">
          {players.map((pl, i) => (
            <button
              key={pl.unitId}
              className={
                i === Math.min(idx, players.length - 1) ? "active" : ""
              }
              onClick={() => setIdx(i)}
            >
              <span
                className="rpt-meter-dot"
                style={{
                  background: classColor(pl.classId),
                  borderColor: classColor(pl.classId),
                }}
              />
              {pl.name}
            </button>
          ))}
        </div>
      </div>

      {p.bursts.length > 0 && (
        <div className="rpt-ledger-section">
          <span className="rpt-stats-detail-title">爆发对齐</span>
          {p.bursts.map((b, k) => {
            const t = b.dominantTarget;
            const immunities =
              t?.defensivesHit.filter((d) => d.isImmunity) ?? [];
            const walls = t?.defensivesHit.filter((d) => !d.isImmunity) ?? [];
            return (
              <div key={k} className="rpt-ledger-row">
                <span className="rpt-stats-detail-t">
                  {fmtT(b.fromSeconds)}–{fmtT(b.toSeconds)}
                </span>
                <span className="rpt-ledger-spells">
                  {b.spells.map((s) => s.spellName).join(" + ")}
                </span>
                {t ? (
                  <span>
                    → {t.unitName}
                    {t.hpStartPct !== null && t.hpEndPct !== null
                      ? `(${Math.round(t.hpStartPct)}%→${Math.round(t.hpEndPct)}%)`
                      : ""}{" "}
                    {fmtDmg(t.damage)}
                  </span>
                ) : (
                  <Chip kind="warn">未打出伤害</Chip>
                )}
                {immunities.map((d) => (
                  <Chip key={d.spellId} kind="bad">
                    打进免疫 {d.spellName} {d.overlapSeconds.toFixed(1)}s
                  </Chip>
                ))}
                {walls.map((d) => (
                  <Chip key={d.spellId} kind="warn">
                    对方减伤 {d.spellName} {d.overlapSeconds.toFixed(1)}s
                  </Chip>
                ))}
                {b.allyCDsOverlapping.length > 0 ? (
                  <Chip kind="good">
                    协同{" "}
                    {b.allyCDsOverlapping.map((a) => a.playerName).join("、")}
                  </Chip>
                ) : (
                  <Chip kind="dim">单开</Chip>
                )}
                {t?.died && <Chip kind="kill">击杀</Chip>}
                <SeekBtn tS={b.fromSeconds} unitName={p.name} onSeek={onSeek} />
              </div>
            );
          })}
        </div>
      )}

      {p.bursts.length === 0 && (
        <p className="rpt-ledger-empty">本场无爆发窗口记录。</p>
      )}

      {p.targeting.length === 0 ? (
        <p className="rpt-ledger-empty">本场无窗口目标纪律记录。</p>
      ) : (
        <div className="rpt-ledger-section">
          <span className="rpt-stats-detail-title">窗口目标纪律</span>
          {p.targeting.map((w, k) => {
            const targetEval = targetEvalByFrom.get(w.windowFromSeconds);
            return (
              <div key={k} className="rpt-ledger-row">
                <span className="rpt-stats-detail-t">
                  {fmtT(w.windowFromSeconds)}–{fmtT(w.windowToSeconds)}
                </span>
                <span>窗口目标 {w.windowTargetName}</span>
                <Chip kind={w.onTargetPct >= 50 ? "good" : "bad"}>
                  命中 {w.onTargetPct}%
                </Chip>
                {w.topOffTarget && w.onTargetPct < 50 && (
                  <span className="rpt-stats-dim">
                    最大分流 {w.topOffTarget.unitName}(
                    {fmtDmg(w.topOffTarget.damage)})
                  </span>
                )}
                {targetEval &&
                  (targetEval.betterTargetExists ? (
                    <Chip kind="bad">
                      该打 {targetEval.betterTargetName}(
                      {targetEval.betterTargetSpec})
                    </Chip>
                  ) : (
                    <Chip kind="good">目标合理</Chip>
                  ))}
                <SeekBtn
                  tS={w.windowFromSeconds}
                  unitName={p.name}
                  onSeek={onSeek}
                />
              </div>
            );
          })}
        </div>
      )}

      {p.kicks.length === 0 ? (
        <p className="rpt-ledger-empty">本场无打断记录。</p>
      ) : (
        <div className="rpt-ledger-section">
          <span className="rpt-stats-detail-title">打断审计</span>
          {p.kicks.map((kk, k) => (
            <div key={k} className="rpt-ledger-row">
              <span className="rpt-stats-detail-t">{fmtT(kk.atSeconds)}</span>
              <span>{kk.kickSpellName}</span>
              {kk.result === "landed" && (
                <Chip kind="good">打断 {kk.interruptedSpellName}</Chip>
              )}
              {kk.result === "juked" && (
                <Chip kind="bad">被假读条骗掉({kk.jukedBySpellName})</Chip>
              )}
              {kk.result === "missed" && <Chip kind="warn">落空</Chip>}
              {kk.result === "unknown" && (
                <Chip kind="dim">旧档无读条数据</Chip>
              )}
              <SeekBtn tS={kk.atSeconds} unitName={p.name} onSeek={onSeek} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
