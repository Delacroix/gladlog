import { useState } from "react";

import type { AuraUptime } from "../derive/auraUptime";
import type { CCChainRow } from "../derive/ccChainDash";
import type { DispelDash } from "../derive/dispelDash";
import type { KickDashRow } from "../derive/kickDash";
import type { TimeRange } from "../derive/timeRange";
import { AuraUptimeCard } from "./AuraUptimeCard";
import { CCChainPanel } from "./CCChainPanel";
import { DispelDashboard } from "./DispelDashboard";
import { KickDashboard } from "./KickDashboard";

type Tab = "kick" | "dispel" | "aura" | "cc";

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

  const TABS: { key: Tab; label: string }[] = [
    { key: "kick", label: kickN > 0 ? `打断 ${kickN}` : "打断" },
    { key: "dispel", label: dispelN > 0 ? `驱散 ${dispelN}` : "驱散" },
    { key: "aura", label: "光环" },
    { key: "cc", label: ccN > 0 ? `CC链 ${ccN}` : "CC链" },
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
      </div>
    </div>
  );
}
