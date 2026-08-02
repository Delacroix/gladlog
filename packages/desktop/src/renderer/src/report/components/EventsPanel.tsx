import { SPELL_ICONS_GENERATED } from "@gladlog/analysis";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { bridge } from "../../bridge";
import { SpellIcon } from "./SpellIcon";
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

/** Spell icon on an event row: if the id is not in the generated table, render
 * nothing (an empty label keeps the fallback initial from duplicating the spell
 * name text beside it, same convention as FindingsList's ChipIcon). The constant
 * 22px row height is a design premise of the virtualization — a 14px icon plus
 * .rpt-events-spell's inline-flex must not stretch the row. */
function EvtSpell({ spellId, name }: { spellId?: string; name: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  return (
    <span className="rpt-events-spell">
      {icon && <SpellIcon icon={icon} label="" size={14} />}
      {name}
    </span>
  );
}

/** Virtualized row height (the "constant row height" design premise of
 * eventsView.ts; same source as the old paginated loadMore's 22px assumption).
 * Event counts run into the tens of thousands, and the old "append on scroll,
 * never reclaim" approach reached 100k+ DOM nodes at the bottom (2026-07-26
 * audit); with fixed row height plus top/bottom spacers, the DOM stays at a
 * constant ~200 rows. */
const ROW_H = 22;
/** Window overscan in rows; hysteresis = half an overscan, so scrolling does not re-render every frame. */
const OVERSCAN_ROWS = 40;

/**
 * The events view (phase 4 ②, a structured-filter take on WCL Events):
 * five filter dimensions — kind chips / unit / spell substring / window anchor
 * (whole match · global time range · kill-attempt and vulnerability bands) —
 * plus ▶ per-row jump into the replay. The window anchor covers 90% of the use
 * cases people hand-write `IN RANGE FROM..TO` expressions for in WCL, with the
 * options reusing windows we already compute.
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
  /** The global time range (selected in the report view); one of the anchor options. */
  globalRange: TimeRange | null;
  onSeek?: (tSeconds: number, unitNames: string[]) => void;
  /** B2 provenance request (finding → "raw events"): presets the filters whenever nonce changes. */
  inspectReq?: {
    fromS: number;
    toS: number;
    unitName: string | null;
    nonce: number;
  } | null;
  /** Storage id (the directory holding raw.txt); when absent the raw-line button is hidden (fixtures / test bed). */
  matchId?: string;
  /** Direct jump from a death row's "▶ death recap" (MatchReport injects the openRecap pipeline). */
  onOpenRecap?: (unitId: string, tMs: number) => void;
}) {
  // For a single shuffle round, lineIndex is an index within that round; the
  // offset into the whole raw.txt is accumulated on the main side from the
  // preceding rounds' linesTotal (matchStore.rawLine), so we only pass
  // sequenceNumber here.
  const roundSeq =
    source.kind === "shuffleRound" ? source.sequenceNumber : null;
  const [rawView, setRawView] = useState<{
    key: string;
    text: string | null;
    fileLine: number | null;
  } | null>(null);
  // The key includes the render index: one instant can hold several identical-looking
  // rows (AoE), so one click must not expand a whole batch
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
  // Anchor key: 'all' | 'global' | 'custom' | 'band:<i>' — the range is resolved
  // from the key on every render
  const [anchor, setAnchor] = useState<string>(globalRange ? "global" : "all");
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);

  // Applying a provenance request: ±15s window + unit filter, clearing the kind
  // and spell filters (so the target event does not get filtered away)
  useEffect(() => {
    if (!inspectReq) return;
    setCustomRange({ fromS: inspectReq.fromS, toS: inspectReq.toS });
    setAnchor("custom");
    setUnitName(inspectReq.unitName);
    setKinds([]);
    setSpellQuery("");
  }, [inspectReq?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // useMemo is mandatory: if the object literal in the band branch got a new
  // identity every render, `filtered` would be recomputed every render, and the
  // "scroll back to top on filter change" effect depends on [filtered] — so the
  // moment the user scrolls (which re-renders via setScrollAnchor) they get
  // yanked back to the top and the table is stuck on the first screen
  // (agy review, F1).
  const range: TimeRange | null = useMemo(
    () =>
      anchor === "custom"
        ? customRange
        : anchor === "global"
          ? globalRange
          : anchor.startsWith("band:")
            ? (() => {
                const b = bands[Number(anchor.slice(5))];
                return b ? { fromS: b.fromS, toS: b.toS } : null;
              })()
            : null,
    [anchor, customRange, globalRange, bands],
  );

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

  // Baseline for the amount micro-bars: p95 of the current filtered result (not
  // max, so a single huge hit does not flatten everything else)
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

  // Expansion state of aggregate groups (keys are filter-independent, so changing
  // filters does not lose it)
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

  // Virtualization scroll anchor (with hysteresis: setState only after scrolling
  // past half an overscan, so scrolling does not re-render every frame; it also
  // replaced the old "unconditionally read scrollHeight after render", which
  // forced a layout on every render).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollAnchor, setScrollAnchor] = useState(0);
  const anchorRef = useRef(0);
  const viewHRef = useRef(600);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    viewHRef.current = el.clientHeight || viewHRef.current;
    const st = el.scrollTop;
    if (Math.abs(st - anchorRef.current) > (OVERSCAN_ROWS * ROW_H) / 2) {
      anchorRef.current = st;
      setScrollAnchor(st);
    }
  };
  // Filter or data change: scroll back to top (equivalent to the old pagination
  // semantics — setShown(PAGE) meant returning to page one). useLayoutEffect so
  // the scroll-to-top setState re-renders synchronously before paint; otherwise
  // the new list paints one frame of mid-list content at the old scroll position
  // before jumping to the top (agy review, F6).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    anchorRef.current = 0;
    setScrollAnchor(0);
  }, [filtered]);
  // When the container resizes (toggling the sidebar, resizing the window) the
  // window's upper bound must grow with it, and a ref does not trigger a
  // re-render — force one with an epoch counter (agy review, F5).
  const [, setViewEpoch] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      viewHRef.current = el.clientHeight || viewHRef.current;
      setViewEpoch((e) => e + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggleKind = (k: EventKind) => {
    setKinds((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );
  };

  // Flatten into a fixed-row-height sequence (group rows + expanded children);
  // the virtualization slices this sequence. Keys keep the old render-index
  // scheme (g{i}/g{i}:{j}/{i}), so behavior is unchanged.
  // rawView's inline expansion row is not counted in the spacer height: a
  // few dozen px of error on one row, self-healing as soon as you scroll.
  const flat = useMemo(() => {
    const out: Array<
      | {
          t: "group";
          d: Extract<DisplayRow, { children: EventRow[] }>;
          gk: string;
          key: string;
        }
      | { t: "row"; d: EventRow; key: string; child: boolean }
    > = [];
    filtered.rows.forEach((d, i) => {
      if (isGroupRow(d)) {
        const gk = groupKey(d);
        out.push({ t: "group", d, gk, key: `g${i}` });
        if (expandedGroups.has(gk))
          d.children.forEach((c, j) =>
            out.push({ t: "row", d: c, key: `g${i}:${j}`, child: true }),
          );
      } else {
        out.push({ t: "row", d, key: String(i), child: false });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, expandedGroups]);

  const winFrom = Math.max(0, Math.floor(scrollAnchor / ROW_H) - OVERSCAN_ROWS);
  const winTo = Math.min(
    flat.length,
    Math.ceil((scrollAnchor + viewHRef.current) / ROW_H) + OVERSCAN_ROWS,
  );

  // Amount micro-bar: width = amount / p95 (clamped to 100%)
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
        <td>
          {r.kind === "death" ? (
            "阵亡"
          ) : (
            <EvtSpell spellId={r.spellId} name={r.spellName} />
          )}
        </td>
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
          }}
        />
        <span className="rpt-stats-dim">
          {filtered.matched} / {allRows.length} 条
        </span>
      </div>
      <div className="rpt-events-scroll" ref={scrollRef} onScroll={onScroll}>
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
            {/* The spacer must contain a td: a tr with no cells collapses to
                zero height in browser table layout (agy review, F2), which
                breaks virtual scrolling entirely. Queries exclude it with
                tr:not([aria-hidden]) (see the provenance test). */}
            {winFrom > 0 && (
              <tr aria-hidden="true">
                <td
                  colSpan={7}
                  style={{ height: winFrom * ROW_H, padding: 0, border: 0 }}
                />
              </tr>
            )}
            {flat.slice(winFrom, winTo).map((item) => {
              if (item.t === "row")
                return renderEventRow(item.d, item.key, item.child);
              const d = item.d;
              const gk = item.gk;
              const open = expandedGroups.has(gk);
              const caret = (
                <span className="rpt-events-caret">{open ? "▾" : "▸"}</span>
              );
              if (d.kind === "aura-flood") {
                return (
                  <tr className="rpt-events-group" key={item.key}>
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
                );
              }
              return (
                <tr className="rpt-events-group" key={item.key}>
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
                      <EvtSpell spellId={d.spellId} name={d.spellName} />
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
              );
            })}
            {winTo < flat.length && (
              <tr aria-hidden="true">
                <td
                  colSpan={7}
                  style={{
                    height: (flat.length - winTo) * ROW_H,
                    padding: 0,
                    border: 0,
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
