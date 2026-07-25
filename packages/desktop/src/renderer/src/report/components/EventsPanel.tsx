import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { bridge } from "../../bridge";
import {
  deriveEventRows,
  EMPTY_EVENTS_FILTER,
  EVENT_KIND_LABEL,
  filterDisplayRows,
  fmtEventAmt,
  groupEventRows,
  isGroupRow,
  type DisplayRow,
  type EventKind,
  type EventRow,
} from "../derive/eventsView";
import type { TimeRange } from "../derive/timeRange";
import type { ReportSource } from "../derive/types";
import type { VulnBand } from "../derive/vulnWindows";

const fmtT = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** 一次渲染的行数上限;超出分页加载(事件量在万级,别一次挂全部 DOM)。 */
const PAGE = 300;

/**
 * events 视图(第四阶段②,WCL Events 的结构化过滤版):
 * 类型 chips / 单位 / 技能子串 / 窗口锚定(全场・全局时间窗・击杀/脆弱窗)
 * 五维过滤 + ▶ 逐行跳回放。窗口锚定 = WCL 手写 `IN RANGE FROM..TO`
 * 表达式的 90% 用例,选项直接用现成的计算窗口。
 */
export function EventsPanel({
  source,
  bands,
  globalRange,
  onSeek,
  inspectReq,
  matchId,
  onOpenRecap,
}: {
  source: ReportSource;
  bands: VulnBand[];
  /** 全局时间窗(战报视图选的);作为锚定选项之一。 */
  globalRange: TimeRange | null;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  /** B2 溯源请求(finding →「原始事件」):nonce 变化时预置过滤。 */
  inspectReq?: {
    fromS: number;
    toS: number;
    unitName: string | null;
    nonce: number;
  } | null;
  /** 存储 id(raw.txt 所在目录);缺省时原始行按钮隐藏(fixture/测试台)。 */
  matchId?: string;
  /** 死亡行「▶ 死亡回顾」直达(MatchReport 注入 openRecap 管线)。 */
  onOpenRecap?: (unitId: string, tMs: number) => void;
}) {
  // shuffle 单回合的 lineIndex 是轮内下标;整场 raw.txt 偏移由 main 端按
  // 前序轮 linesTotal 累加(matchStore.rawLine),这里只带 sequenceNumber。
  const roundSeq =
    source.kind === "shuffleRound" ? source.sequenceNumber : null;
  const [rawView, setRawView] = useState<{
    key: string;
    text: string | null;
    fileLine: number | null;
  } | null>(null);
  // key 含渲染序号:同一时刻可有多条同源行(AoE),别一键展开一片
  const rawKeyOf = (r: { tS: number; lineIndex?: number }, i: string) =>
    `${i}:${r.tS}:${r.lineIndex}`;
  const toggleRaw = async (
    r: { tS: number; lineIndex?: number },
    i: string,
  ) => {
    const key = rawKeyOf(r, i);
    if (rawView?.key === key) {
      setRawView(null);
      return;
    }
    try {
      const res = await bridge().matches.rawLine(matchId!, {
        roundSeq,
        lineIndex: r.lineIndex!,
      });
      setRawView({
        key,
        text: res?.line ?? null,
        fileLine: res?.fileLine ?? null,
      });
    } catch {
      setRawView({ key, text: null, fileLine: null });
    }
  };
  const allRows = useMemo(() => deriveEventRows(source), [source]);
  const unitNames = useMemo(
    () =>
      [
        ...new Set(
          Object.values(source.units)
            .filter((u) => u.kind === "Player" && u.info)
            .map((u) => u.name.split("-")[0]!),
        ),
      ].sort(),
    [source],
  );

  const [kinds, setKinds] = useState<EventKind[]>([]);
  const [unitName, setUnitName] = useState<string | null>(null);
  const [spellQuery, setSpellQuery] = useState("");
  // 锚定键:'all' | 'global' | 'custom' | 'band:<i>' —— 每次渲染从键解 range
  const [anchor, setAnchor] = useState<string>(globalRange ? "global" : "all");
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [shown, setShown] = useState(PAGE);

  // 溯源请求落地:±15s 窗口 + 单位过滤,清掉类型/技能过滤(别把目标事件滤没)
  useEffect(() => {
    if (!inspectReq) return;
    setCustomRange({ fromS: inspectReq.fromS, toS: inspectReq.toS });
    setAnchor("custom");
    setUnitName(inspectReq.unitName);
    setKinds([]);
    setSpellQuery("");
    setShown(PAGE);
  }, [inspectReq?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const range: TimeRange | null =
    anchor === "custom"
      ? customRange
      : anchor === "global"
        ? globalRange
        : anchor.startsWith("band:")
          ? (() => {
              const b = bands[Number(anchor.slice(5))];
              return b ? { fromS: b.fromS, toS: b.toS } : null;
            })()
          : null;

  const displayRows = useMemo(() => groupEventRows(allRows), [allRows]);
  const countsByKind = useMemo(() => {
    const m = new Map<EventKind, number>();
    for (const r of allRows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [allRows]);

  const filtered = useMemo(
    () =>
      filterDisplayRows(displayRows, {
        ...EMPTY_EVENTS_FILTER,
        kinds,
        unitName,
        spellQuery,
        range,
      }),
    [displayRows, kinds, unitName, spellQuery, range],
  );

  // 数额微条基准:当前过滤结果的 p95(不用 max,防单笔巨额压扁全部)
  const amountP95 = useMemo(() => {
    const amts: number[] = [];
    for (const d of filtered.rows) {
      if (isGroupRow(d)) {
        if (d.kind === "tick-group") amts.push(d.amount);
      } else if (d.amount != null && d.amount > 0) amts.push(d.amount);
    }
    if (amts.length === 0) return 0;
    amts.sort((a, b) => a - b);
    return amts[Math.floor(0.95 * (amts.length - 1))]!;
  }, [filtered]);

  // 聚合组展开态(键与过滤无关,换过滤不丢)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const groupKey = (d: DisplayRow): string =>
    `${d.kind}:${d.tS}:${"destName" in d ? d.destName : ""}`;
  const toggleGroup = (key: string) =>
    setExpandedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // 滚动加载:近底(30 行)续一页;渲染后同一判定兜底,容器未填满时
  // 自动补页(IntersectionObserver 在隐藏标签页会被节流,弃用)。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasMore = filtered.rows.length > shown;
  const maybeLoadMore = () => {
    const el = scrollRef.current;
    // clientHeight 0 = 未布局(jsdom/隐藏容器),别把整表灌进 DOM
    if (!el || !hasMore || el.clientHeight === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 22 * 30)
      setShown((n) => n + PAGE);
  };
  useEffect(() => {
    maybeLoadMore();
  });

  const toggleKind = (k: EventKind) => {
    setKinds((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );
    setShown(PAGE);
  };

  // 数额微条:宽度 = amount / p95(截断到 100%)
  const amtCell = (
    rowKind: EventKind,
    amount: number | undefined,
    text: string,
  ) =>
    amount != null && amount > 0 && amountP95 > 0 ? (
      <span className={`rpt-events-amt rpt-events-amt-${rowKind}`}>
        <span className="rpt-events-amt-bar">
          <span
            style={{ width: `${Math.min(100, (100 * amount) / amountP95)}%` }}
          />
        </span>
        {text}
      </span>
    ) : (
      text
    );

  const renderEventRow = (r: EventRow, i: string, child = false) => (
    <Fragment key={i}>
      <tr
        className={
          [
            r.kind === "death" ? "rpt-events-death" : "",
            child ? "rpt-events-childrow" : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        <td className="rpt-stats-detail-t">{fmtT(r.tS)}</td>
        <td>{EVENT_KIND_LABEL[r.kind]}</td>
        <td>{r.srcName}</td>
        <td>{r.destName}</td>
        <td>{r.kind === "death" ? "阵亡" : r.spellName}</td>
        <td className="rpt-stats-dim">
          {r.kind === "damage" || r.kind === "heal" ? (
            amtCell(r.kind, r.amount, r.detail)
          ) : r.kind === "death" && onOpenRecap && r.destId ? (
            <button
              className="rpt-stats-detail-jump"
              title="打开死亡回顾"
              onClick={() =>
                onOpenRecap(r.destId!, source.startTime + r.tS * 1000)
              }
            >
              ▶ 死亡回顾
            </button>
          ) : (
            r.detail
          )}
        </td>
        <td>
          {matchId && r.lineIndex != null && (
            <button
              className="rpt-stats-detail-jump"
              title="查看原始日志行"
              onClick={() => void toggleRaw(r, i)}
            >
              ㏒
            </button>
          )}
          {onSeek && (
            <button
              className="rpt-stats-detail-jump"
              title="回放此刻"
              onClick={() =>
                onSeek(
                  Math.max(0, r.tS - 3),
                  [r.destName || r.srcName].filter(Boolean),
                )
              }
            >
              ▶
            </button>
          )}
        </td>
      </tr>
      {rawView?.key === rawKeyOf(r, i) && (
        <tr className="rpt-events-rawline">
          <td colSpan={7}>
            {rawView.text ? (
              <code>
                {rawView.fileLine != null && (
                  <span className="rpt-stats-dim">
                    raw.txt:{rawView.fileLine + 1}{" "}
                  </span>
                )}
                {rawView.text}
              </code>
            ) : (
              <span className="rpt-stats-dim">
                原始行不可用(旧档无行号或 raw.txt 缺失)
              </span>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );

  return (
    <div className="rpt-events" data-testid="events-panel">
      <div className="rpt-events-filters">
        <div className="rpt-events-kinds">
          {(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((k) => {
            const n = countsByKind.get(k) ?? 0;
            return (
              <button
                key={k}
                className={[
                  "rpt-events-kind-chip",
                  kinds.includes(k) ? "active" : "",
                  n === 0 ? "zero" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => toggleKind(k)}
              >
                <span className={`rpt-events-kind-dot ${k}`} />
                {EVENT_KIND_LABEL[k]}
                <span className="rpt-events-kind-cnt">{n}</span>
              </button>
            );
          })}
        </div>
        <select
          value={unitName ?? ""}
          onChange={(e) => {
            setUnitName(e.target.value || null);
            setShown(PAGE);
          }}
          title="来源或目标含该玩家"
        >
          <option value="">全部玩家</option>
          {unitNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          value={anchor}
          onChange={(e) => {
            setAnchor(e.target.value);
            setShown(PAGE);
          }}
          title="窗口锚定"
        >
          <option value="all">全场</option>
          {customRange && (
            <option value="custom">
              溯源窗口 {fmtT(customRange.fromS)}–{fmtT(customRange.toS)}
            </option>
          )}
          {globalRange && (
            <option value="global">
              全局时间窗 {fmtT(globalRange.fromS)}–{fmtT(globalRange.toS)}
            </option>
          )}
          {bands.map((b, i) => (
            <option key={i} value={`band:${i}`}>
              {fmtT(b.fromS)}–{fmtT(b.toS)}{" "}
              {b.kind === "burst" ? "击杀尝试" : "脆弱"} ·{" "}
              {b.targetName.split("-")[0]}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="技能名过滤…"
          value={spellQuery}
          onChange={(e) => {
            setSpellQuery(e.target.value);
            setShown(PAGE);
          }}
        />
        <span className="rpt-stats-dim">
          {filtered.matched} / {allRows.length} 条
        </span>
      </div>
      <div
        className="rpt-events-scroll"
        ref={scrollRef}
        onScroll={maybeLoadMore}
      >
        <table className="rpt-stats rpt-events-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>来源</th>
              <th>目标</th>
              <th>技能</th>
              <th>详情</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.rows.slice(0, shown).map((d, i) => {
              if (isGroupRow(d)) {
                const gk = groupKey(d);
                const open = expandedGroups.has(gk);
                const caret = (
                  <span className="rpt-events-caret">{open ? "▾" : "▸"}</span>
                );
                if (d.kind === "aura-flood") {
                  return (
                    <Fragment key={`g${i}`}>
                      <tr className="rpt-events-group">
                        <td className="rpt-stats-detail-t">{fmtT(d.tS)}</td>
                        <td>{EVENT_KIND_LABEL.aura}</td>
                        <td />
                        <td>{d.destName}</td>
                        <td colSpan={2}>
                          <button
                            className="rpt-events-group-btn"
                            onClick={() => toggleGroup(gk)}
                          >
                            {caret}
                            {d.destName} {d.count} 个光环同时消失
                            {d.deathClear && (
                              <span className="rpt-events-group-chip">
                                死亡清场
                              </span>
                            )}
                          </button>
                        </td>
                        <td />
                      </tr>
                      {open &&
                        d.children.map((c, j) =>
                          renderEventRow(c, `g${i}:${j}`, true),
                        )}
                    </Fragment>
                  );
                }
                return (
                  <Fragment key={`g${i}`}>
                    <tr className="rpt-events-group">
                      <td className="rpt-stats-detail-t">{fmtT(d.tS)}</td>
                      <td>{EVENT_KIND_LABEL[d.rowKind]}</td>
                      <td>{d.srcName}</td>
                      <td>{d.destName}</td>
                      <td>
                        <button
                          className="rpt-events-group-btn"
                          onClick={() => toggleGroup(gk)}
                        >
                          {caret}
                          {d.spellName}
                          <span className="rpt-events-group-chip">
                            ×{d.count} tick
                          </span>
                        </button>
                      </td>
                      <td className="rpt-stats-dim">
                        {amtCell(d.rowKind, d.amount, fmtEventAmt(d.amount))}
                      </td>
                      <td />
                    </tr>
                    {open &&
                      d.children.map((c, j) =>
                        renderEventRow(c, `g${i}:${j}`, true),
                      )}
                  </Fragment>
                );
              }
              return renderEventRow(d, String(i));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
