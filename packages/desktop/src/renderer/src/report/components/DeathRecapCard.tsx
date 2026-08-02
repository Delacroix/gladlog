import { DECISIVE_MARGIN_PCT } from "@gladlog/analysis";

import type { DeathRecap } from "../derive/deathRecap";
import { ChipIcon } from "./SpellInline";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const KIND_LABEL: Record<string, string> = {
  dmg: "伤害",
  heal: "治疗",
  cc: "控制",
  def_used: "防御",
};

/**
 * One-line text for the mitigation audit (form A, #17b Task4) — the Chinese card
 * version. Numbers are taken straight from IMitigationAuditRow (the return value
 * of Task1's computeMitigationAudit) and never re-derived.
 */
function mitigationText(row: DeathRecap["mitigationAudit"][number]): string {
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

/** A mitigation audit row: ChipIcon (the id is known; a missing table entry
 *  degrades to nothing on its own) + the text. */
function MitigationLine({
  row,
}: {
  row: DeathRecap["mitigationAudit"][number];
}) {
  return (
    <>
      <ChipIcon spellId={row.spellId} />
      {mitigationText(row)}
    </>
  );
}

/**
 * One-line text for a decisive counterfactual (B / narrow-gate merge, #17b
 * Task4) — worded as a possibility, arithmetic-only and single-factor, with the
 * margin coming from the same source as DECISIVE_MARGIN_PCT (Task1's
 * single-source constant).
 */
function counterfactualText(
  hit: DeathRecap["counterfactuals"][number],
): string {
  const subject =
    hit.source === "missed-external" && hit.casterName
      ? `${hit.casterName} 的 ${hit.spellName}`
      : hit.spellName;
  return `若${subject}覆盖此窗,该段伤害约降至致死线下(余量 >${DECISIVE_MARGIN_PCT}% 最大血量)——算术口径,单因素`;
}

/** A decisive counterfactual row: ChipIcon (the id is known) + the text, wired
 *  up the same way as the mitigation row's icon. */
function CounterfactualLine({
  hit,
}: {
  hit: DeathRecap["counterfactuals"][number];
}) {
  return (
    <>
      <ChipIcon spellId={hit.spellId} />
      {counterfactualText(hit)}
    </>
  );
}

/**
 * Death recap drawer card (backlog #6): the 10s event stream before the death +
 * defensives that were available but never pressed + externals a teammate failed
 * to give. Every judgement comes from the analysis predicates
 * (deriveDeathRecaps).
 */
export function DeathRecapCard({
  recap,
  onClose,
  onJump,
  enemy = false,
}: {
  recap: DeathRecap;
  onClose: () => void;
  /** Replay this instant (relative seconds). */
  onJump?: (tSeconds: number, unitNames: string[]) => void;
  /** An enemy death (the fallback when auto-recap finds no friendly death): the
   * title switches to "kill" wording — an enemy dying is a result, and it should
   * not be headed "death recap" as if we were reviewing our own side. */
  enemy?: boolean;
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
              <td className="rpt-recap-spell">
                <ChipIcon spellId={e.spellId} />
                {e.spell}
                {e.kind === "def_used" && e.panic && (
                  <span
                    className="rpt-recap-panic-badge"
                    title="恐慌性使用:未见明显敌方威胁/目标未受压下按下"
                  >
                    ⚠恐慌
                  </span>
                )}
              </td>
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
              {/* Strip the realm suffix (convention across the whole UI): a
                  cross-realm full name blows out the 384px right column
                  horizontally (proven on a real match in acceptance run 2); the
                  full name goes into title */}
              <td className="rpt-recap-src" title={e.srcName}>
                {e.srcName.split("-")[0]}
              </td>
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
          {enemy ? "终结回顾" : "死亡回顾"} — {recap.unitName} @{" "}
          {fmtT(recap.deathS)}
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
              <ChipIcon spellId={i.spellId} />
              {i.spellName}
              {i.wasInCC ? "(当时被控)" : ""}
              {i.cheaperAlternatives.length > 0 && (
                <span className="rpt-recap-cheaper">
                  {" "}
                  · 更省替代:{i.cheaperAlternatives.join("、")}
                </span>
              )}
            </span>
          ))}
        </p>
      )}
      {recap.missedExternals.length > 0 && (
        <p className="rpt-recap-verdictish">
          队友可给未给:
          {recap.missedExternals.map((m, k) => (
            <span key={k} className="rpt-recap-pill">
              <ChipIcon spellId={m.spellId} />
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
                <MitigationLine row={row} />
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
              <CounterfactualLine hit={hit} />
            </p>
          ))}
        </div>
      )}

      {/* Inner scroll (per the 1a spec's "timeline 5 rows" and the .rpt-windows
          precedent): the 10s before a death in a long round can hold dozens of
          small events, and without scrolling the whole right column stretches to
          several screens (proven in acceptance run 2).
          tabIndex: the table rows contain no focusable element, so the
          scrollable region must be reachable by keyboard itself (axe
          scrollable-region-focusable, caught immediately by the CI baseline
          run). */}
      <div
        className="rpt-recap-scroll"
        tabIndex={0}
        role="region"
        aria-label="死前事件时间线(可滚动)"
      >
        {table}
      </div>
    </div>
  );
}
