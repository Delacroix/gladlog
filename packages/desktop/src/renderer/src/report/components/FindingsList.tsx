import type { CandidateEvent, Finding } from "@gladlog/analysis";
import { useState } from "react";

import { findingKey } from "../../../../shared/findingKey";
import {
  candidateShortLabel,
  categoryLabel,
  severityLabel,
} from "../derive/findingDisplay";
import { ChipIcon } from "./SpellInline";
export { findingKey };

const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;

export function FindingsList({
  findings,
  onSelect,
  onJump,
  onJumpT,
  onInspect,
  candidates,
  flags,
  onFlag,
  lang = "zh",
  habitOf,
}: {
  findings: Finding[];
  onSelect: (eventIds: string[]) => void;
  /** 跳到回放:定位到该 finding 引用的最早事件时刻。 */
  onJump?: (eventIds: string[]) => void;
  /** 深挖 chips 直跳(相对秒 + 单位)。 */
  onJumpT?: (tSeconds: number, unitNames: string[]) => void;
  /** B2 溯源:跳 events 视图并预置「该时刻 ± 窗口 + 该单位」过滤。 */
  onInspect?: (tSeconds: number, unitNames: string[]) => void;
  /** 候选事件池:证据 chip 显示每条证据的发生时刻(可各自点跳)。 */
  candidates?: CandidateEvent[];
  /** 跟进标记(phase3 #3a):key = findingKey(f)。 */
  flags?: Record<string, string>;
  onFlag?: (key: string, flag: "done" | "recurring" | null) => void;
  /** severity 本地化(EN 回复模式保持英文);category 原样(聚合键,勿映射)。 */
  lang?: "zh" | "en";
  /** 跨对局惯性徽章(spec §4):返回徽章文本或 null。文本由确定性 stats
   * 插值(habitBadgeText),不经过模型。 */
  habitOf?: (f: Finding) => string | null;
}) {
  const [open, setOpen] = useState<Record<number, boolean>>({});

  if (findings.length === 0) {
    return (
      <div className="rpt-ai-body">
        <p className="rpt-ai-none">No findings for this match.</p>
      </div>
    );
  }

  return (
    <div className="rpt-findings">
      {findings.map((f, i) => {
        const clampable = f.explanation.length > 90;
        const expanded = !!open[i];
        return (
          <div key={i} className={`rpt-finding rpt-finding-${f.severity}`}>
            <div className="rpt-finding-head">
              <span className="rpt-finding-sev">
                {severityLabel(f.severity, lang)} ·{" "}
                {categoryLabel(f.category, lang)}
              </span>
              <span className="rpt-finding-title">{f.title}</span>
              {(() => {
                const habit = habitOf?.(f);
                return habit ? (
                  <span
                    className="rpt-finding-habit"
                    title="跨对局稳定模式(确定性统计,非 AI 判断)"
                  >
                    {habit}
                  </span>
                ) : null;
              })()}
            </div>
            <p
              className={
                clampable && !expanded
                  ? "rpt-finding-body clamp"
                  : "rpt-finding-body"
              }
            >
              {f.explanation}
            </p>
            {f.deepDive && (
              <div className="rpt-finding-deep" data-testid="finding-deepdive">
                <span className="rpt-finding-deep-tag">深挖</span>
                <p className="rpt-finding-deep-text">{f.deepDive.text}</p>
                <span className="rpt-finding-deep-chips">
                  {f.deepDive.chips.map((c, ci) => (
                    <button
                      key={ci}
                      className="rpt-finding-evt"
                      title={c.label}
                      onClick={
                        onJump ? () => onJumpT?.(c.t, c.unitNames) : undefined
                      }
                    >
                      <ChipIcon spellId={c.spellId} />⏱ {mmss(c.t)} {c.label}
                    </button>
                  ))}
                </span>
              </div>
            )}
            {clampable && (
              <button
                className="rpt-finding-toggle"
                onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}
              >
                {expanded ? "收起 ▴" : "展开全文 ▾"}
              </button>
            )}
            {f.eventIds && f.eventIds.length > 0 && (
              <div className="rpt-finding-ev">
                <button onClick={() => onSelect(f.eventIds)}>Evidence</button>
                {/* 每条证据的发生时刻:各自可点跳到回放对应瞬间 */}
                {(candidates ?? [])
                  .filter(
                    (c) => f.eventIds.includes(c.id) && Number.isFinite(c.t),
                  )
                  .sort((a, b) => a.t - b.t)
                  .map((c) => (
                    <button
                      key={c.id}
                      className="rpt-finding-evt"
                      title={
                        // 有技能时把技能名带进 tooltip:图标本身不表意
                        (c.spell ? `${c.spell} · ` : "") +
                        (onJump ? `跳到 ${mmss(c.t)} 的回放` : mmss(c.t))
                      }
                      onClick={onJump ? () => onJump([c.id]) : undefined}
                    >
                      <ChipIcon spellId={c.spellId} />⏱ {mmss(c.t)}{" "}
                      {candidateShortLabel(c)}
                    </button>
                  ))}
                {onJump && (
                  <button
                    className="rpt-finding-jump"
                    onClick={() => onJump(f.eventIds)}
                  >
                    ▶ 回放此刻
                  </button>
                )}
                {onInspect &&
                  (() => {
                    // B2 溯源:取该 finding 最早的证据事件为锚
                    const first = (candidates ?? [])
                      .filter(
                        (c) =>
                          f.eventIds.includes(c.id) && Number.isFinite(c.t),
                      )
                      .sort((a, b) => a.t - b.t)[0];
                    if (!first) return null;
                    return (
                      <button
                        className="rpt-finding-jump"
                        title="在事件视图里查看该时刻的原始事件"
                        onClick={() => onInspect(first.t, first.unitNames)}
                      >
                        ⛏ 原始事件
                      </button>
                    );
                  })()}
              </div>
            )}
            {/* 跟进标记独立于证据守卫:无 eventIds 的 finding 也能标记(agy 复核) */}
            {onFlag &&
              (() => {
                const key = findingKey(f);
                const cur = flags?.[key];
                return (
                  <span className="rpt-finding-flags">
                    <button
                      className={cur === "done" ? "active" : ""}
                      title="标记为已改进"
                      onClick={() =>
                        onFlag(key, cur === "done" ? null : "done")
                      }
                    >
                      ✓ 已跟进
                    </button>
                    <button
                      className={cur === "recurring" ? "active rec" : ""}
                      title="标记为还在犯"
                      onClick={() =>
                        onFlag(key, cur === "recurring" ? null : "recurring")
                      }
                    >
                      ↻ 还在犯
                    </button>
                  </span>
                );
              })()}
          </div>
        );
      })}
    </div>
  );
}
