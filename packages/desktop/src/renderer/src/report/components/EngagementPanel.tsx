import { useState } from "react";

import type { AuraUptime } from "../derive/auraUptime";
import type { CcBreakDash, CcBreakRow } from "../derive/ccBreakDash";
import type { CCChainRow } from "../derive/ccChainDash";
import type { DispelDash } from "../derive/dispelDash";
import type { KickDashRow } from "../derive/kickDash";
import type { TimeRange } from "../derive/timeRange";
import { AuraUptimeCard } from "./AuraUptimeCard";
import { CCChainPanel } from "./CCChainPanel";
import { DispelDashboard } from "./DispelDashboard";
import { KickDashboard } from "./KickDashboard";

type Tab = "kick" | "dispel" | "aura" | "cc" | "break";

const fmtBreakT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** 破控行清单(资敌/敌方自误共用;DispelDashboard.InstanceList 同款行形)。 */
function CcBreakList({
  items,
  onSeek,
}: {
  items: CcBreakRow[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
}) {
  return (
    <div className="rpt-stats-detail-group">
      {items.map((i, k) => (
        <span key={k} className="rpt-stats-detail-item">
          <span className="rpt-stats-detail-t">{fmtBreakT(i.tS)}</span>{" "}
          {i.label}
          {onSeek && (
            <button
              className="rpt-stats-detail-jump"
              title="回放此刻"
              onClick={() => onSeek(Math.max(0, i.tS - 3), [i.unitName])}
            >
              ▶
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * 对局面板(UI 改版 1a):打断/驱散/光环/CC链 四张低密度卡合成一张 tab 卡,
 * 替代原先各占整行的独立堆叠。内容组件原样复用(判定谓词不动),外壳由
 * CSS `.rpt-engage` 打平(嵌套的 .rpt-ledger 去边框、隐藏自带标题行 ——
 * tab 即标题)。空 tab 统一「本回合无记录」,不再各卡自说自话的空壳文案。
 */
export function EngagementPanel({
  kickRows,
  dispelDash,
  auraUptime,
  ccRows,
  ccBreak,
  onSeek,
  range,
  tab: tabProp,
  onTab,
  roundish = false,
}: {
  kickRows: KickDashRow[];
  dispelDash: DispelDash;
  auraUptime: AuraUptime;
  ccRows: CCChainRow[];
  /** 打破控制统计(2026-08-02);不传则不显示该 tab(旧调用方/测试平滑)。 */
  ccBreak?: CcBreakDash;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  range?: TimeRange | null;
  /** 受控 tab(MatchReport 持有:视图切换不丢);不传则内部自持(测试)。 */
  tab?: Tab;
  onTab?: (t: Tab) => void;
  /** shuffle 回合 → 空态说「本轮」;普通对局说「本场」(agy 复核 #8)。 */
  roundish?: boolean;
}) {
  const [tabLocal, setTabLocal] = useState<Tab>("kick");
  const tab = tabProp ?? tabLocal;
  const setTab = onTab ?? setTabLocal;

  const kickN = kickRows.reduce((a, r) => a + r.total, 0);
  const dispelN = dispelDash.rows.reduce(
    (a, r) => a + r.cleanses + r.purges + r.steals,
    0,
  );
  const dispelHasAnything =
    dispelDash.rows.length +
      dispelDash.missedPurges.length +
      dispelDash.missedCleanses.length >
    0;
  const ccN = ccRows.length;
  const breakN = ccBreak ? ccBreak.friendly.length + ccBreak.enemy.length : 0;
  const breakHasAnything = !!ccBreak && breakN + ccBreak.rootBreakCount > 0;

  const TABS: { key: Tab; label: string }[] = [
    { key: "kick", label: kickN > 0 ? `打断 ${kickN}` : "打断" },
    { key: "dispel", label: dispelN > 0 ? `驱散 ${dispelN}` : "驱散" },
    { key: "aura", label: "光环" },
    { key: "cc", label: ccN > 0 ? `CC链 ${ccN}` : "CC链" },
    ...(ccBreak
      ? [
          {
            key: "break" as Tab,
            label: breakN > 0 ? `破控 ${breakN}` : "破控",
          },
        ]
      : []),
  ];

  const empty = (
    <p className="rpt-engage-empty">{roundish ? "本轮" : "本场"}无记录。</p>
  );

  return (
    <div className="rpt-engage" data-testid="engagement-panel">
      {/* 与 Meters 的 mode 段控同款朴素按钮 —— 不用 ARIA tab 角色:
          ShuffleReport 的回合胶囊是页面唯一 tablist,别混进 getAllByRole 计数 */}
      <div className="rpt-mode-seg rpt-engage-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={`engage-tab-${t.key}`}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="rpt-engage-body">
        {tab === "kick" &&
          (kickRows.length > 0 ? (
            <KickDashboard rows={kickRows} onSeek={onSeek} />
          ) : (
            empty
          ))}
        {tab === "dispel" &&
          (dispelHasAnything ? (
            <DispelDashboard dash={dispelDash} onSeek={onSeek} />
          ) : (
            empty
          ))}
        {tab === "aura" &&
          (auraUptime.groups.length > 0 ? (
            <AuraUptimeCard data={auraUptime} range={range} />
          ) : (
            empty
          ))}
        {tab === "cc" &&
          (ccRows.length > 0 ? (
            <CCChainPanel rows={ccRows} onSeek={onSeek} />
          ) : (
            empty
          ))}
        {tab === "break" &&
          ccBreak &&
          (breakHasAnything ? (
            <div data-testid="ccbreak-panel">
              {ccBreak.friendly.length > 0 && (
                <>
                  <p className="rpt-ccbreak-head rpt-ccbreak-bad">
                    资敌打破 —— 己方伤害打断了挂在敌人身上的控制(
                    {ccBreak.friendly.length})
                  </p>
                  <CcBreakList items={ccBreak.friendly} onSeek={onSeek} />
                </>
              )}
              {ccBreak.enemy.length > 0 && (
                <>
                  <p className="rpt-ccbreak-head rpt-ccbreak-good">
                    敌方自误 —— 对面自己打断了给我方上的控制(
                    {ccBreak.enemy.length},正面信号)
                  </p>
                  <CcBreakList items={ccBreak.enemy} onSeek={onSeek} />
                </>
              )}
              {ccBreak.rootBreakCount > 0 && (
                <p className="rpt-ccbreak-foot">
                  另有定身(root)被打破 {ccBreak.rootBreakCount} 次 ——
                  定身常被刻意打破换位置,单列不计教学。
                </p>
              )}
            </div>
          ) : (
            empty
          ))}
      </div>
    </div>
  );
}
