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

/** 事件行技能图标:id 查不到生成表 → 什么都不渲染(空 label 防兜底首字母
 * 与旁边的技能名文字重复,同 FindingsList ChipIcon 的约定)。行高恒定 22px
 * 是窗口化的设计前提 —— 图标 14px + .rpt-events-spell 的 inline-flex 不撑行。 */
function EvtSpell({ spellId, name }: { spellId?: string; name: string }) {
  const icon = spellId ? SPELL_ICONS_GENERATED[spellId] : undefined;
  return (
    <span className="rpt-events-spell">
      {icon && <SpellIcon icon={icon} label="" size={14} />}
      {name}
    </span>
  );
}

/** 窗口化行高(eventsView.ts 的「行高恒定」设计前提;旧分页 loadMore 的
 * 22px 假设同源)。事件量在万级,旧「滚动追加、永不回收」滚到底是 10 万+
 * DOM 节点(2026-07-26 审计);改固定行高 + 上下 spacer 的窗口化,DOM
 * 常数在 ~200 行。 */
const ROW_H = 22;
/** 窗口过扫描行数;迟滞 = 半个过扫描,滚动不逐帧重渲。 */
const OVERSCAN_ROWS = 40;

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

  // 溯源请求落地:±15s 窗口 + 单位过滤,清掉类型/技能过滤(别把目标事件滤没)
  useEffect(() => {
    if (!inspectReq) return;
    setCustomRange({ fromS: inspectReq.fromS, toS: inspectReq.toS });
    setAnchor("custom");
    setUnitName(inspectReq.unitName);
    setKinds([]);
    setSpellQuery("");
  }, [inspectReq?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // 必须 useMemo:band 分支的对象字面量若每渲染新身份,filtered 会跟着每
  // 渲染重算,而「换过滤回顶」effect 依赖 [filtered] —— 用户一滚动(触发
  // setScrollAnchor 重渲)就被拽回顶部,表格锁死在第一屏(agy 复核 F1)。
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

  // 窗口化滚动锚(带迟滞:滚过半个过扫描才 setState,滚动不逐帧重渲;
  // 也替换了旧的「渲染后无条件读 scrollHeight」——那是每次渲染一次强制布局)。
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
  // 换过滤/换数据:回顶(旧分页语义等价 —— setShown(PAGE) 就是回到第一页)。
  // useLayoutEffect:回顶的 setState 在 paint 前同步重渲,否则新列表先按旧
  // 滚动位置画一帧中段内容再跳回顶(agy 复核 F6)。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    anchorRef.current = 0;
    setScrollAnchor(0);
  }, [filtered]);
  // 容器尺寸变化(开关侧栏/改窗口)时窗口上界要跟着长,ref 不触发重渲 ——
  // 用 epoch 逼一次(agy 复核 F5)。
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

  // 展平为固定行高序列(组行 + 已展开的子行),窗口化在这个序列上切片。
  // key 沿用旧的渲染序号方案(g{i}/g{i}:{j}/{i}),行为不变。
  // rawView 的内联展开行不计入 spacer 高度:单行几十 px 的误差,滚动即自愈。
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
            {/* spacer 必须有 td:无 cell 的 tr 在浏览器 table 布局里塌成
                0 高(agy 复核 F2),虚拟滚动整个失效。查询方用
                tr:not([aria-hidden]) 排除(见 provenance 测试)。 */}
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
