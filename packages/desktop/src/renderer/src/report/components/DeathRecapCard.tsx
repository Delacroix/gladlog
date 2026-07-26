import type { DeathRecap } from "../derive/deathRecap";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const KIND_LABEL: Record<string, string> = {
  dmg: "伤害",
  heal: "治疗",
  cc: "控制",
  def_used: "防御",
};

/**
 * 死亡回顾抽屉卡(backlog #6):死前 10s 事件流 + 可用未按的保命技 +
 * 队友漏给的外部。判定全部来自 analysis 谓词(deriveDeathRecaps)。
 */
export function DeathRecapCard({
  recap,
  onClose,
  onJump,
}: {
  recap: DeathRecap;
  onClose: () => void;
  /** 回放此刻(相对秒)。 */
  onJump?: (tSeconds: number, unitNames: string[]) => void;
}) {
  const table = (
    <table className="rpt-recap-table">
      <tbody>
        {recap.events.map((e, i) => {
          const hasHp = e.hpBeforePct !== undefined && e.hpAfterPct !== undefined;
          return (
            <tr key={i} className={`rpt-recap-row rpt-recap-${e.kind}`}>
              <td className="rpt-recap-t">{fmtT(e.tS)}</td>
              <td className="rpt-recap-kind">{KIND_LABEL[e.kind]}</td>
              <td className="rpt-recap-spell">{e.spell}</td>
              <td
                className={`rpt-recap-amt ${
                  e.kind === "dmg"
                    ? "rpt-recap-amt-dmg"
                    : e.kind === "heal"
                      ? "rpt-recap-amt-heal"
                      : ""
                }`}
              >
                {e.amount != null ? `${(e.amount / 1000).toFixed(1)}k` : ""}
              </td>
              <td
                className="rpt-recap-hpbar"
                title={hasHp ? `${Math.round(e.hpBeforePct!)}% → ${Math.round(e.hpAfterPct!)}%` : undefined}
              >
                {hasHp && (
                  <span className="rpt-recap-hpbar-track">
                    <span
                      className="rpt-recap-hpbar-base"
                      style={{ width: `${Math.min(e.hpBeforePct!, e.hpAfterPct!).toFixed(1)}%` }}
                    />
                    <span
                      className={`rpt-recap-hpbar-delta rpt-recap-hpbar-delta-${
                        e.kind === "dmg" ? "dmg" : "heal"
                      }`}
                      style={{
                        left: `${Math.min(e.hpBeforePct!, e.hpAfterPct!).toFixed(1)}%`,
                        width: `${Math.abs(e.hpBeforePct! - e.hpAfterPct!).toFixed(1)}%`,
                      }}
                    />
                  </span>
                )}
              </td>
              <td className="rpt-recap-src">{e.srcName}</td>
            </tr>
          );
        })}
        {recap.events.length === 0 && (
          <tr>
            <td colSpan={6} className="rpt-recap-empty">
              死前 10s 无记录事件。
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <div className="rpt-recap" data-testid="death-recap">
      <div className="rpt-recap-head">
        <span className="rpt-recap-title">
          死亡回顾 — {recap.unitName} @ {fmtT(recap.deathS)}
        </span>
        <span className="rpt-recap-actions">
          {onJump && (
            <button
              className="rpt-finding-jump"
              onClick={() =>
                onJump(Math.max(0, recap.deathS - 8), [recap.unitName])
              }
            >
              ▶ 回放此刻
            </button>
          )}
          <button className="rpt-recap-close" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      {recap.availableImmunities.length > 0 && (
        <p className="rpt-recap-verdictish">
          死亡时可用而未按:
          {recap.availableImmunities.map((i, k) => (
            <span key={k} className="rpt-recap-pill">
              {i.spellName}
              {i.wasInCC ? "(当时被控)" : ""}
            </span>
          ))}
        </p>
      )}
      {recap.missedExternals.length > 0 && (
        <p className="rpt-recap-verdictish">
          队友可给未给:
          {recap.missedExternals.map((m, k) => (
            <span key={k} className="rpt-recap-pill">
              {m.casterName}:{m.spellName}
              {m.casterWasInCC ? "(被控)" : ""}
            </span>
          ))}
        </p>
      )}

      {table}
    </div>
  );
}
