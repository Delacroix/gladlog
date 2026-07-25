import type { CandidateEvent, Finding } from "@gladlog/analysis";
import { useMemo, useState } from "react";

import { findingKey } from "../../../../shared/findingKey";
import {
  candidateShortLabel,
  categoryLabel,
  severityLabel,
} from "../derive/findingDisplay";
import type { KeyMoment } from "../derive/keyMoments";

const GAP_S = 30;
/** 相邻同类 minor 间隔 ≤5s → 折叠为一条连发。 */
const CLUSTER_GAP_S = 5;
/** 长局阀门:条目总数超过它时,minor 段默认收成「+N 次要时刻」。 */
const VALVE_MAX_ENTRIES = 40;

const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;

/** 统一文本字形(禁 emoji:🛡♱ 跨平台渲染不一)。 */
const KIND_ICON: Record<KeyMoment["kind"], string> = {
  death: "✕",
  "burst-band": "▮",
  defensive: "◆",
  dispel: "✛",
  cc: "◎",
};

const KIND_ZH: Record<KeyMoment["kind"], string> = {
  death: "死亡",
  "burst-band": "爆发",
  defensive: "防御",
  dispel: "驱散",
  cc: "控制",
};

type Entry =
  | { at: number; kind: "moment"; m: KeyMoment }
  | { at: number; kind: "cluster"; mkind: KeyMoment["kind"]; ms: KeyMoment[] }
  | { at: number; kind: "finding"; f: Finding };
type KeyedEntry = Entry & { key: string };
type Row =
  KeyedEntry | { at: number; kind: "more"; key: string; items: KeyedEntry[] };

const isMinorRow = (e: KeyedEntry): boolean =>
  e.kind === "cluster" || (e.kind === "moment" && e.m.weight === "minor");

/** 关键时刻轴:静态叙事脊柱,系统事件与 finding 卡按时间交错,可点跳回放。
 * P0-2:death/burst-band + finding 卡为 major(完整药丸),防御/驱散/控制为
 * minor 小字行,同类连发折叠;长局再收「+N 次要时刻」阀门。 */
export function KeyMomentAxis({
  moments,
  findings,
  candidates,
  onSeek,
  onSelectEvidence,
  flags,
  onFlag,
  lang = "zh",
}: {
  moments: KeyMoment[];
  findings: Finding[];
  candidates: CandidateEvent[];
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  /** finding 卡的证据高亮(与 FindingsList onSelect 同契约)。 */
  onSelectEvidence: (eventIds: string[]) => void;
  flags?: Record<string, string>;
  onFlag?: (key: string, flag: "done" | "recurring" | null) => void;
  /** severity 本地化(EN 回复模式保持英文);category 原样(聚合键,勿映射)。 */
  lang?: "zh" | "en";
}) {
  const byId = useMemo(
    () => new Map(candidates.map((c) => [c.id, c])),
    [candidates],
  );
  // 归并 + 排序 + minor 同类连发折叠(1g:单侧左轨,不再左右交错)
  const entries = useMemo(() => {
    const merged: Entry[] = [
      ...moments.map((m): Entry => ({ at: m.t, kind: "moment", m })),
      ...findings.flatMap((f): Entry[] => {
        const ts = (f.eventIds ?? [])
          .map((id) => byId.get(id)?.t)
          .filter((t): t is number => Number.isFinite(t));
        return ts.length ? [{ at: Math.min(...ts), kind: "finding", f }] : [];
      }),
    ].sort((a, b) => a.at - b.at);

    // 相邻同类 minor、间隔 ≤5s → 一条连发
    const clustered: Entry[] = [];
    let i = 0;
    while (i < merged.length) {
      const e = merged[i]!;
      if (e.kind === "moment" && e.m.weight === "minor") {
        const run = [e.m];
        let j = i + 1;
        while (j < merged.length) {
          const n = merged[j]!;
          if (
            n.kind !== "moment" ||
            n.m.weight !== "minor" ||
            n.m.kind !== e.m.kind ||
            // 同 kind 不同 side(被控 vs 控制成功)极性相反,不并
            n.m.side !== e.m.side ||
            n.at - merged[j - 1]!.at > CLUSTER_GAP_S
          )
            break;
          run.push(n.m);
          j++;
        }
        if (run.length >= 2) {
          clustered.push({
            at: e.at,
            kind: "cluster",
            mkind: e.m.kind,
            ms: run,
          });
          i = j;
          continue;
        }
      }
      clustered.push(e);
      i++;
    }

    return clustered.map((e): KeyedEntry => {
      const key =
        e.kind === "finding"
          ? `f:${findingKey(e.f)}`
          : e.kind === "cluster"
            ? `c:${e.mkind}:${e.at}:${e.ms.length}`
            : `m:${e.m.kind}:${e.m.t}:${e.m.title}:${e.m.unitNames.join(",")}`;
      return { ...e, key };
    });
  }, [moments, findings, byId]);

  // 长局阀门:总条目 >40 → 连续 minor 段收成「+N 次要时刻」行,点击展开
  const [openSegs, setOpenSegs] = useState<Set<string>>(new Set());
  const rows = useMemo((): Row[] => {
    if (entries.length <= VALVE_MAX_ENTRIES) return entries;
    const out: Row[] = [];
    let i = 0;
    while (i < entries.length) {
      const e = entries[i]!;
      if (isMinorRow(e)) {
        let j = i;
        while (j < entries.length && isMinorRow(entries[j]!)) j++;
        const items = entries.slice(i, j);
        out.push({ at: e.at, kind: "more", key: `seg:${e.key}`, items });
        i = j;
        continue;
      }
      out.push(e);
      i++;
    }
    return out;
  }, [entries]);

  // 节点圆描边色(1g):击杀窗口/爆发带 = 金,死亡按敌我,finding 按严重度
  const nodeColor = (e: Row): string => {
    if (e.kind === "more") return "var(--hairline)";
    if (e.kind === "finding")
      return e.f.severity === "high"
        ? "var(--loss)"
        : e.f.severity === "med"
          ? "var(--gold)"
          : "var(--mute)";
    if (e.kind === "cluster") return "var(--accent-line)";
    if (e.m.kind === "burst-band") return "var(--gold)";
    if (e.m.kind === "death" || e.m.kind === "cc")
      return e.m.side === "friendly" ? "var(--loss)" : "var(--win)";
    return "var(--accent-line)";
  };

  const minorNode = (m: KeyMoment, key: string) => (
    <button
      key={key}
      className={`rpt-axis-node-minor k-${m.kind} s-${m.side}`}
      data-testid="axis-node-minor"
      title={onSeek ? `跳到 ${mmss(m.jumpT)} 的回放` : undefined}
      onClick={onSeek ? () => onSeek(m.jumpT, m.unitNames) : undefined}
    >
      <span className="rpt-axis-icon">{KIND_ICON[m.kind]}</span>
      <span className="rpt-axis-title">{m.title}</span>
      {m.detail && <span className="rpt-axis-detail">{m.detail}</span>}
    </button>
  );

  const clusterNode = (e: Extract<Entry, { kind: "cluster" }>, key: string) => {
    const titles = e.ms.map((m) => m.title);
    return (
      <button
        key={key}
        className="rpt-axis-node-minor rpt-axis-cluster"
        data-testid="axis-node-minor"
        title={titles.join(" · ")}
        onClick={
          onSeek ? () => onSeek(e.ms[0]!.jumpT, e.ms[0]!.unitNames) : undefined
        }
      >
        <span className="rpt-axis-icon">{KIND_ICON[e.mkind]}</span>
        <span className="rpt-axis-title">
          {KIND_ZH[e.mkind]} ×{e.ms.length}:{titles.slice(0, 2).join(" · ")}
          {titles.length > 2 ? " …" : ""}
        </span>
      </button>
    );
  };

  const renderEntry = (e: KeyedEntry) => {
    if (e.kind === "cluster") return clusterNode(e, e.key);
    if (e.kind === "moment" && e.m.weight === "minor")
      return minorNode(e.m, e.key);
    if (e.kind === "moment")
      return (
        <button
          key={e.key}
          className={`rpt-axis-node k-${e.m.kind} s-${e.m.side}`}
          data-testid="axis-node"
          title={onSeek ? `跳到 ${mmss(e.m.jumpT)} 的回放` : undefined}
          onClick={onSeek ? () => onSeek(e.m.jumpT, e.m.unitNames) : undefined}
        >
          <span className="rpt-axis-icon">{KIND_ICON[e.m.kind]}</span>
          <span className="rpt-axis-title">{e.m.title}</span>
          {e.m.kind === "burst-band" && e.m.toT != null && (
            <span className="rpt-axis-detail">
              {mmss(e.at)}–{mmss(e.m.toT)}
            </span>
          )}
          {e.m.detail && <span className="rpt-axis-detail">{e.m.detail}</span>}
        </button>
      );
    return (
      <div
        key={e.key}
        className={`rpt-finding rpt-finding-${e.f.severity} rpt-axis-finding`}
        data-testid="axis-node"
      >
        <div className="rpt-finding-head">
          <span className="rpt-finding-sev">
            {severityLabel(e.f.severity, lang)} ·{" "}
            {categoryLabel(e.f.category, lang)}
          </span>
          <span className="rpt-finding-title">{e.f.title}</span>
        </div>
        <p className="rpt-finding-body">{e.f.explanation}</p>
        {e.f.deepDive && (
          <div className="rpt-finding-deep" data-testid="finding-deepdive">
            <span className="rpt-finding-deep-tag">深挖</span>
            <p className="rpt-finding-deep-text">{e.f.deepDive.text}</p>
            <span className="rpt-finding-deep-chips">
              {e.f.deepDive.chips.map((c, ci) => (
                <button
                  key={ci}
                  className="rpt-finding-evt"
                  title={c.label}
                  onClick={onSeek ? () => onSeek(c.t, c.unitNames) : undefined}
                >
                  ⏱ {mmss(c.t)} {c.label}
                </button>
              ))}
            </span>
          </div>
        )}
        <div className="rpt-finding-ev">
          <button onClick={() => onSelectEvidence(e.f.eventIds)}>
            Evidence
          </button>
          {/* 每条证据的发生时刻 + 短标签 chip(FindingsList 同款,可各自点跳) */}
          {(e.f.eventIds ?? [])
            .map((id) => byId.get(id))
            .filter((c): c is CandidateEvent => !!c && Number.isFinite(c.t))
            .sort((a, b) => a.t - b.t)
            .map((c) => (
              <button
                key={c.id}
                className="rpt-finding-evt"
                title={
                  (c.spell ? `${c.spell} · ` : "") +
                  (onSeek ? `跳到 ${mmss(c.t)} 的回放` : mmss(c.t))
                }
                onClick={onSeek ? () => onSeek(c.t, c.unitNames) : undefined}
              >
                ⏱ {mmss(c.t)} {candidateShortLabel(c)}
              </button>
            ))}
          {onSeek && (
            <button
              className="rpt-finding-jump"
              onClick={() => {
                const evs = (e.f.eventIds ?? [])
                  .map((id) => byId.get(id))
                  .filter((c): c is CandidateEvent => !!c);
                onSeek(e.at, [...new Set(evs.flatMap((c) => c.unitNames))]);
              }}
            >
              ▶ 回放此刻
            </button>
          )}
          {onFlag &&
            (() => {
              const key = findingKey(e.f);
              const cur = flags?.[key];
              return (
                <span className="rpt-finding-flags">
                  <button
                    className={cur === "done" ? "active" : ""}
                    title="标记为已改进"
                    onClick={() => onFlag(key, cur === "done" ? null : "done")}
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
      </div>
    );
  };

  return (
    <div className="rpt-axis" data-testid="key-moment-axis">
      {rows.map((e, i) => {
        const prev = rows[i - 1];
        const gap = prev && e.at - prev.at > GAP_S ? e.at - prev.at : null;
        const expanded = e.kind === "more" && openSegs.has(e.key);
        return (
          <div key={e.key} className="rpt-axis-item">
            {gap !== null && (
              <div className="rpt-axis-gap" data-testid="axis-gap">
                ⏱ {Math.round(gap)}s 无关键事件 — 折叠
              </div>
            )}
            <span className="rpt-axis-t">{mmss(e.at)}</span>
            <div
              className={
                i === rows.length - 1 ? "rpt-axis-entry last" : "rpt-axis-entry"
              }
            >
              <span
                className="rpt-axis-dot"
                style={{ borderColor: nodeColor(e) }}
              />
              {e.kind === "more" ? (
                expanded ? (
                  <span className="rpt-axis-seg">
                    {e.items.map((it) => renderEntry(it))}
                  </span>
                ) : (
                  <button
                    className="rpt-axis-more"
                    data-testid="axis-more"
                    onClick={() =>
                      setOpenSegs((cur) => new Set(cur).add(e.key))
                    }
                  >
                    +
                    {e.items.reduce(
                      (s, it) => s + (it.kind === "cluster" ? it.ms.length : 1),
                      0,
                    )}{" "}
                    次要时刻
                  </button>
                )
              ) : (
                renderEntry(e)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
