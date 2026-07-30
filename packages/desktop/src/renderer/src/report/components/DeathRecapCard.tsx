import { DECISIVE_MARGIN_PCT } from "@gladlog/analysis";

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
 * 减伤核算(A 形态,#17b Task4)单行文案——中文卡片版,数字直接取
 * IMitigationAuditRow(Task1 computeMitigationAudit 的返回值),不重新推导。
 */
function mitigationLine(row: DeathRecap["mitigationAudit"][number]): string {
  const overlap = row.activeOverlapS.toFixed(1);
  if (row.kind === "arith") {
    const blockedK = Math.round((row.blockedAmount ?? 0) / 1000);
    const pctPart =
      row.blockedPctMaxHp !== undefined
        ? `(≈${row.blockedPctMaxHp}% maxHp)`
        : "";
    return `${row.spellName} 挡了 ~${blockedK}k${pctPart},覆盖 ${overlap}s`;
  }
  if (row.kind === "immunity") {
    const dmgK = Math.round((row.damageTakenDuringImmunity ?? 0) / 1000);
    return `${row.spellName} 免疫覆盖 ${overlap}s(期内观测承伤 ~${dmgK}k)`;
  }
  return `${row.spellName} 激活 ${overlap}s,机制特殊(转移/反弹),不参与缺口算术`;
}

/**
 * decisive 反事实(B/窄门合并,#17b Task4)单行文案——可能性措辞,
 * 算术口径单因素,margin 与 DECISIVE_MARGIN_PCT(Task1 单源常量)同源。
 */
function counterfactualLine(
  hit: DeathRecap["counterfactuals"][number],
): string {
  const subject =
    hit.source === "missed-external" && hit.casterName
      ? `${hit.casterName} 的 ${hit.spellName}`
      : hit.spellName;
  return `若${subject}覆盖此窗,该段伤害约降至致死线下(余量 >${DECISIVE_MARGIN_PCT}% 最大血量)——算术口径,单因素`;
}

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
          const hasHp =
            e.hpBeforePct !== undefined && e.hpAfterPct !== undefined;
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
                title={
                  hasHp
                    ? `${Math.round(e.hpBeforePct!)}% → ${Math.round(e.hpAfterPct!)}%`
                    : undefined
                }
              >
                {hasHp && (
                  <span className="rpt-recap-hpbar-track">
                    <span
                      className="rpt-recap-hpbar-base"
                      style={{
                        width: `${Math.min(e.hpBeforePct!, e.hpAfterPct!).toFixed(1)}%`,
                      }}
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

      {recap.mitigationAudit.length > 0 && (
        <div className="rpt-recap-mitigation" data-testid="recap-mitigation">
          <p className="rpt-recap-mitigation-title">
            减伤核算(死亡窗内已激活,逐条独立口径,不建模叠加):
          </p>
          <ul className="rpt-recap-mitigation-list">
            {recap.mitigationAudit.map((row, k) => (
              <li
                key={k}
                className={`rpt-recap-mitigation-row rpt-recap-mitigation-${row.kind}`}
              >
                {mitigationLine(row)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {recap.counterfactuals.length > 0 && (
        <div
          className="rpt-recap-counterfactual"
          data-testid="recap-counterfactual"
        >
          {recap.counterfactuals.map((hit, k) => (
            <p
              key={k}
              className="rpt-recap-verdictish rpt-recap-counterfactual-line"
            >
              {counterfactualLine(hit)}
            </p>
          ))}
        </div>
      )}

      {table}
    </div>
  );
}
