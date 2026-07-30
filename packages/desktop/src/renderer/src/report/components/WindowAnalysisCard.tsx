import type { ReactNode } from "react";

import { fmtTime } from "@gladlog/analysis";

import { ChipIcon } from "./SpellInline";

/** 深挖 chip 同款形状(FindingsList/StructuredAnalysisPanel 的 deepDive.chips
 * 一致);#16 选段分析走独立通路,不复用 Finding 类型,单独导出便于 renderer
 * 拼装。 */
export type Chips = Array<{
  t: number;
  label: string;
  unitNames: string[];
  /** 仅供 UI 出图标(SPELL_ICONS_GENERATED);无单一技能的条目留空。 */
  spellId?: string;
}>;

export type WindowCardState =
  | { phase: "loading" }
  | { phase: "result"; text: string; chips: Chips; fromCache: boolean }
  | { phase: "none" } // 无信号(确定性,零成本,门在 renderer 已过滤——不调模型)
  | { phase: "audit-empty" } // 模型输出全部未过审计 → 可重试
  | { phase: "no-client" } // 未配置 AI
  | { phase: "error" } // 网络/服务异常(与 audit-empty 分开,同样可重试)
  | { phase: "busy" }; // 同场同窗口已有一次在飞(幂等守卫命中)→ 可重试,不轮询

/** 选段分析终态卡(#16):对当前拖选窗口的一次性深挖结果,六种终态。
 * 样式复用 finding 卡(`rpt-finding rpt-finding-low`),chips 行同
 * FindingsList 深挖 chips 的约定(ChipIcon + fmtTime + 点击跳回放)。 */
export function WindowAnalysisCard({
  state,
  range,
  rich,
  onJumpT,
  onRetry,
}: {
  state: WindowCardState;
  range: { fromS: number; toS: number };
  rich: (t?: string | null) => ReactNode;
  onJumpT: (tSeconds: number, unitNames: string[]) => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="rpt-finding rpt-finding-low rpt-window-ai"
      data-testid="window-ai-card"
    >
      <div className="rpt-finding-head">
        <span className="rpt-finding-title">
          选段分析 {fmtTime(range.fromS)}–{fmtTime(range.toS)}
        </span>
        {state.phase === "result" && state.fromCache && (
          <span className="rpt-finding-habit" title="本窗口的分析结果来自缓存">
            (缓存)
          </span>
        )}
      </div>
      {state.phase === "loading" && (
        <p className="rpt-finding-body">分析中…(约 10–30s)</p>
      )}
      {state.phase === "result" && (
        <>
          <p className="rpt-finding-body">{rich(state.text)}</p>
          <span className="rpt-finding-deep-chips">
            {state.chips.map((c, i) => (
              <button
                key={i}
                className="rpt-finding-evt"
                title={c.label}
                onClick={() => onJumpT(c.t, c.unitNames)}
              >
                <ChipIcon spellId={c.spellId} />⏱ {fmtTime(c.t)} {c.label}
              </button>
            ))}
          </span>
        </>
      )}
      {state.phase === "none" && (
        <p className="rpt-finding-body">
          这段未检出可教信号(无受控/防御施放/敌方爆发/HP 骤降等)。
        </p>
      )}
      {state.phase === "audit-empty" && (
        <>
          <p className="rpt-finding-body">模型输出未通过审计。</p>
          <button className="rpt-finding-toggle" onClick={onRetry}>
            重试
          </button>
        </>
      )}
      {state.phase === "error" && (
        <>
          <p className="rpt-finding-body">分析失败(网络或服务异常)。</p>
          <button className="rpt-finding-toggle" onClick={onRetry}>
            重试
          </button>
        </>
      )}
      {state.phase === "no-client" && (
        <p className="rpt-finding-body">未配置 AI(设置里填 API Key 后可用)。</p>
      )}
      {state.phase === "busy" && (
        <>
          <p className="rpt-finding-body">
            该窗口的分析仍在进行中——稍候点重试查看结果。
          </p>
          <button className="rpt-finding-toggle" onClick={onRetry}>
            重试
          </button>
        </>
      )}
    </div>
  );
}
