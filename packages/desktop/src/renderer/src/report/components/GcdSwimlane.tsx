import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { classColor, classGlyph } from "../data/gameConstants";
import { deriveCasts, deriveGcdCasts, isMajorCd } from "../derive/casts";
import { clusterGcdCasts } from "../derive/gcdCluster";
import type { ReplayTrack } from "../derive/replay";
import type { ReportSource } from "../derive/types";
import type { VulnBand } from "../derive/vulnWindows";
import { SpellIcon } from "./SpellIcon";

const PX_PER_SEC = 16;
const GCD_MS = 1500;
const TICK_SEC = 5; // 1f:刻度从 15s 加密到 5s(背景另有每 5s 分隔线)
const HEAD_H = 30; // 列头高度,时间轴/光标需下移这么多以对齐列体
const CHIP_H = 23;
/** 折叠行里内联显示的小图标上限,超出收进 +N。 */
const MAX_MINIS = 3;
const VIEWPORT_H = 620; // 泳道可视高度(超出纵向滚动)
/** 纵向窗口化的过扫描余量:窗口外的 chip 不进 DOM。长局 laneH 3500px+ 而
 * 视口只有 620px,全量挂载 = 每帧 reconcile ~5000 个元素、82% 在视口外
 * (2026-07-26 审计)。 */
const OVERSCAN_PX = 600;
/** 播放时 chip 的 elapsed/recent 分类按 250ms 量化 —— 每帧(60Hz)重渲
 * 全部 chip 只为挪一次 1px 的类名边界不值得;4Hz 的边界步进肉眼不可辨。
 * 暂停/seek 态用精确 t:视觉基线截图必须逐像素稳定。 */
const T_QUANT_MS = 250;

const reactionRing = (reaction: string): string =>
  reaction === "Friendly"
    ? "var(--win)"
    : reaction === "Hostile"
      ? "var(--loss)"
      : "var(--mute)";

const mmss = (sec: number): string =>
  `${Math.floor(sec / 60)}:${Math.floor(sec % 60)
    .toString()
    .padStart(2, "0")}`;

function Dot({ track }: { track: ReplayTrack }) {
  return (
    <span
      className="rpt-gcd-dot"
      style={{
        background: classColor(track.classId),
        borderColor: reactionRing(track.reaction),
      }}
    >
      {classGlyph(track.classId)}
    </span>
  );
}

type Laid = { cl: import("../derive/gcdCluster").GcdCluster; y: number };

type FlashReq = { tMs: number; unitNames: string[]; nonce: number } | null;

/**
 * 列体(全部 chip)的 memo 边界:回放时钟 t 60Hz 变化,但本组件只吃
 * 250ms 量化的 tQ 与迟滞化的窗口 [winFrom, winTo] —— 稳态每帧 reconcile
 * 从 ~5000 元素降到 0,4Hz 时降到窗口内 ~900。handler 走父组件的 ref
 * 蹦床(身份恒定),否则 ReplayView 每帧新建的箭头 props 会让 memo 形同虚设。
 */
const LaneBody = memo(function LaneBody({
  cols,
  laidByUnit,
  contentH,
  compact,
  flash,
  tQ,
  playing,
  startTime,
  winFrom,
  winTo,
  friendlyColCount,
  hasSeek,
  hasDeathClick,
  onSeek,
  onDeath,
  yFor,
}: {
  cols: ReplayTrack[];
  laidByUnit: Record<string, Laid[]>;
  contentH: number;
  compact: boolean;
  flash: FlashReq;
  tQ: number;
  playing: boolean;
  startTime: number;
  winFrom: number;
  winTo: number;
  friendlyColCount: number;
  hasSeek: boolean;
  hasDeathClick: boolean;
  onSeek: (tMs: number) => void;
  onDeath: (unitId: string, tMs: number) => void;
  yFor: (ts: number) => number;
}) {
  const fmtT = (ms: number) => {
    const sec = Math.max(0, (ms - startTime) / 1000);
    return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  };
  return (
    <>
      {cols.map((tr, colIdx) => {
        const dead = tr.deathT != null;
        return (
          <div key={tr.unitId} className="rpt-gcd-col-wrap">
            {colIdx === friendlyColCount &&
              friendlyColCount > 0 &&
              colIdx < cols.length && (
                <div
                  className="rpt-gcd-divider"
                  data-testid="gcd-team-divider"
                  style={{ height: contentH + HEAD_H }}
                />
              )}
            <div className={compact ? "rpt-gcd-col compact" : "rpt-gcd-col"}>
              <div
                className={dead ? "rpt-gcd-col-head dead" : "rpt-gcd-col-head"}
              >
                <Dot track={tr} />
                <span className="rpt-gcd-col-name">{tr.name}</span>
              </div>
              <div className="rpt-gcd-col-body" style={{ height: contentH }}>
                {(laidByUnit[tr.unitId] ?? []).map(({ cl, y }, i) => {
                  // 窗口化:视口 ± 过扫描之外的 chip 不进 DOM。
                  if (y < winFrom || y > winTo) return null;
                  const c = cl.primary;
                  const members = [c, ...cl.minis];
                  const elapsed = c.t <= tQ;
                  const recent = elapsed && c.t >= tQ - GCD_MS;
                  const major = members.some((m) => isMajorCd(m.spellId));
                  // 证据链闪金:任一成员时刻 ±2s 内,且(无点名 or 本列被点名)。
                  const flashed =
                    !!flash &&
                    members.some((m) => Math.abs(m.t - flash.tMs) <= 2000) &&
                    (flash.unitNames.length === 0 ||
                      flash.unitNames.includes(tr.name));
                  const cls = [
                    "rpt-gcd-act",
                    isMajorCd(c.spellId) ? "major" : "",
                    playing && !elapsed ? "future" : "",
                    recent ? "recent" : "",
                    flashed ? "flash" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const title =
                    members
                      .map(
                        (m) =>
                          `${fmtT(m.t)} ${m.spellName}${m.targetName ? ` → ${m.targetName}` : ""}`,
                      )
                      .join("\n") + (hasSeek ? "\n(点击定位)" : "");
                  const visMinis = cl.minis.slice(0, MAX_MINIS);
                  const extra = cl.minis.length - visMinis.length;
                  return (
                    <div
                      key={flashed ? `${i}-f${flash.nonce}` : i}
                      className={hasSeek ? `${cls} seekable` : cls}
                      style={{ top: y, left: 4, right: 4, zIndex: 1 }}
                      onClick={hasSeek ? () => onSeek(c.t) : undefined}
                      title={title}
                    >
                      {c.icon ? (
                        <SpellIcon
                          icon={c.icon}
                          label={c.spellName}
                          size={14}
                        />
                      ) : (
                        <span
                          className="rpt-gcd-act-dot"
                          style={{
                            background: isMajorCd(c.spellId)
                              ? "var(--gold)"
                              : classColor(tr.classId),
                          }}
                        />
                      )}
                      {/* 紧凑档:名字进 title,minis 收成 ×N 计数 */}
                      {!compact && (
                        <span className="rpt-gcd-act-name">{c.spellName}</span>
                      )}
                      {!compact &&
                        visMinis.map((m, j) => (
                          <span
                            key={j}
                            className={
                              isMajorCd(m.spellId)
                                ? "rpt-gcd-mini major"
                                : "rpt-gcd-mini"
                            }
                            title={`${fmtT(m.t)} ${m.spellName}`}
                          >
                            {m.icon ? (
                              <SpellIcon
                                icon={m.icon}
                                label={m.spellName}
                                size={12}
                              />
                            ) : (
                              <span className="rpt-gcd-mini-letter">
                                {m.spellName.slice(0, 1)}
                              </span>
                            )}
                          </span>
                        ))}
                      {!compact && extra > 0 && (
                        <span className="rpt-gcd-mini-more">+{extra}</span>
                      )}
                      {compact && cl.minis.length > 0 && (
                        <span className="rpt-gcd-mini-more">
                          ×{cl.minis.length}
                        </span>
                      )}
                      {major ? (
                        <span className="rpt-gcd-act-cd">CD</span>
                      ) : null}
                    </div>
                  );
                })}
                {tr.deathT != null && (
                  <div
                    className={
                      hasDeathClick
                        ? "rpt-gcd-death rpt-gcd-death-click"
                        : "rpt-gcd-death"
                    }
                    style={{ top: yFor(tr.deathT) }}
                    onClick={
                      hasDeathClick
                        ? () => onDeath(tr.unitId, tr.deathT!)
                        : undefined
                    }
                    title={hasDeathClick ? "点击看死亡回顾" : undefined}
                  >
                    阵亡
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
});

/**
 * GCD 泳道:与竞技场共享同一时钟 t。每玩家一列,施法按时间竖直排布;
 * 密集时用碰撞避让下推(不重叠),一条金色时间光标横贯所有列;
 * 已过动作满不透明、未来 .32、最近一个 GCD 描金边。播放时自动跟随光标滚动。
 */
export function GcdSwimlane({
  source,
  tracks,
  t,
  startTime,
  endTime,
  selUnits,
  onToggle,
  playing,
  flash,
  onSeekT,
  onDeathClick,
  bands,
  compact = false,
  onCompactChange,
}: {
  source: ReportSource;
  tracks: ReplayTrack[];
  t: number;
  startTime: number;
  endTime: number;
  selUnits: Record<string, boolean>;
  onToggle: (unitId: string) => void;
  playing: boolean;
  /** 证据链跳转:该时刻 ±2s 内(且命中 unitNames 的列)的 chip 闪金提示。 */
  flash?: FlashReq;
  /** 点 chip → 共享时钟 seek 到该施法时刻(两栏同步)。 */
  onSeekT?: (tMs: number) => void;
  /** 点阵亡 divider → 死亡回顾。 */
  onDeathClick?: (unitId: string, tMs: number) => void;
  /** 击杀/脆弱窗口(P1-6):泳道下方金色跳转 chips,点击 seek 到窗口起点。 */
  bands?: VulnBand[];
  /** 紧凑档(P1-6):列宽收窄,chip 只留图标 + CD 徽标,minis 收成 ×N。 */
  compact?: boolean;
  onCompactChange?: (v: boolean) => void;
}) {
  const durationSec = Math.max(1, (endTime - startTime) / 1000);
  const laneH = durationSec * PX_PER_SEC;
  // useCallback:布局 useMemo 依赖它,裸箭头每帧新身份会再次让 memo 失效。
  const yFor = useCallback(
    (ts: number): number => ((ts - startTime) / 1000) * PX_PER_SEC,
    [startTime],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // handler 蹦床:ReplayView 每帧重渲、传进来的箭头 props 每帧新身份,
  // 直接下传会让 LaneBody 的 memo 形同虚设。ref 现值 + 恒定身份包一层。
  const onSeekTRef = useRef(onSeekT);
  onSeekTRef.current = onSeekT;
  const stableSeek = useCallback((ms: number) => onSeekTRef.current?.(ms), []);
  const onDeathRef = useRef(onDeathClick);
  onDeathRef.current = onDeathClick;
  const stableDeath = useCallback(
    (unitId: string, ms: number) => onDeathRef.current?.(unitId, ms),
    [],
  );

  const castsByUnit = useMemo(() => {
    const map: Record<string, ReturnType<typeof deriveCasts>> = {};
    for (const tr of tracks) map[tr.unitId] = deriveGcdCasts(source, tr.unitId);
    return map;
  }, [source, tracks]);

  // 两队分组:友方列在左、敌方列在右,渲染时在交界画分隔线。
  // 必须 useMemo:这两个数组是下面布局 useMemo 的依赖,裸表达式每次 render 都是
  // 新身份,会让那个 O(列 × 施法数) 的碰撞避让布局每帧重算(memo 形同虚设)。
  const orderedTracks = useMemo(
    () => [
      ...tracks.filter((tr) => tr.reaction === "Friendly"),
      ...tracks.filter((tr) => tr.reaction !== "Friendly"),
    ],
    [tracks],
  );
  const cols = useMemo(
    () => orderedTracks.filter((tr) => selUnits[tr.unitId]),
    [orderedTracks, selUnits],
  );
  const friendlyColCount = cols.filter(
    (tr) => tr.reaction === "Friendly",
  ).length;

  // 布局(2026-07-25 换轴 + 折叠,用户设计):行锚定真实时刻(旧碰撞
  // 下推 10 场实测 92% chips 漂移 >0.5s、均 15.8s、最长 106s);同一
  // GCD 窗口(CHIP_H 对应秒数)内的多个施法折叠成一行 —— 主 chip =
  // 首个 on-GCD,off-GCD 主动技(饰品/打断,官方 offGcdGenerated)与
  // 挤进同窗者折为小图标,超出收 +N。行间零重叠、纵向偏差 ≤ 窗口宽。
  const { laidByUnit, contentH } = useMemo(() => {
    const windowMs = (CHIP_H / PX_PER_SEC) * 1000;
    const laidByUnit: Record<string, Laid[]> = {};
    for (const tr of cols) {
      const casts = (castsByUnit[tr.unitId] ?? []).filter(
        (c) => (tr.deathT == null || c.t <= tr.deathT) && c.t <= endTime,
      );
      laidByUnit[tr.unitId] = clusterGcdCasts(casts, windowMs).map((cl) => ({
        cl,
        y: Math.min(yFor(cl.t), laneH - CHIP_H),
      }));
    }
    return { laidByUnit, contentH: laneH + CHIP_H + 6 };
  }, [cols, castsByUnit, laneH, endTime, yFor]);

  // 视口实高:ResizeObserver 离线测,渲染/滚动路径零 DOM 读 —— 旧实现每
  // 帧 clientHeight 读 + scrollTop 写强制整棵 3500px 容器重排(审计 ⑤c)。
  const clientHRef = useRef(VIEWPORT_H);
  const [, setViewEpoch] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    clientHRef.current = el.clientHeight || VIEWPORT_H;
    if (typeof ResizeObserver === "undefined") return; // jsdom 无此面
    const ro = new ResizeObserver(() => {
      clientHRef.current = el.clientHeight || VIEWPORT_H;
      // ref 不触发重渲,窗口上界不会跟着新高度长 —— epoch 逼一次(agy F5)
      setViewEpoch((e) => e + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 手动滚动的窗口锚(带迟滞:滚过半个过扫描才 setState,滚动不逐帧重渲)。
  // 播放时窗口直接由 t 推导(我们刚写入的 scrollTop 就是它的函数),
  // 滚动事件全部忽略 —— 播放路径零 DOM 读。
  const [manualTop, setManualTop] = useState(0);
  const manualTopRef = useRef(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const onScroll = useCallback(() => {
    if (playingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const st = el.scrollTop;
    if (Math.abs(st - manualTopRef.current) > OVERSCAN_PX / 2) {
      manualTopRef.current = st;
      setManualTop(st);
    }
  }, []);

  // 播放时让光标保持在视口 ~40% 处(clientHeight 走缓存,不再每帧读)
  useEffect(() => {
    if (!playing || !scrollRef.current) return;
    const el = scrollRef.current;
    el.scrollTop = HEAD_H + yFor(t) - clientHRef.current * 0.4;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, playing]);

  // 播放→暂停:窗口锚从当前 scrollTop 接管,否则暂停瞬间窗口还锚在
  // 上次手动位置,视口深处的 chip 全被窗口化剔掉、瞬间白屏。
  // useLayoutEffect:paint 前同步重渲,不闪一帧空白(agy 复核 F3)。
  useLayoutEffect(() => {
    if (playing) return;
    const el = scrollRef.current;
    if (!el) return;
    manualTopRef.current = el.scrollTop;
    setManualTop(el.scrollTop);
  }, [playing]);

  // 证据链跳转:新 flash 请求时滚到目标时刻(暂停态也生效)。
  // useLayoutEffect:窗口锚与 scrollTop 同批落地,不闪一帧目标区空白。
  useLayoutEffect(() => {
    if (!flash || !scrollRef.current) return;
    const el = scrollRef.current;
    const top = HEAD_H + yFor(flash.tMs) - el.clientHeight * 0.4;
    el.scrollTop = top;
    manualTopRef.current = top;
    setManualTop(top);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.nonce]);

  // 播放态:t 量化到 250ms 供 chip 分类/窗口推导;暂停态:精确 t(基线稳定)。
  const tQ = playing ? Math.floor(t / T_QUANT_MS) * T_QUANT_MS : t;
  const winCenter = playing
    ? HEAD_H + yFor(tQ) - clientHRef.current * 0.4
    : manualTop;
  // chip 的 y 是 col-body 内坐标,scrollTop 坐标系比它多 HEAD_H 的列头
  // 偏移 —— 换算到 chip 坐标系再比较(agy 复核 F7)。
  const winFrom = winCenter - OVERSCAN_PX - HEAD_H;
  const winTo = winCenter + clientHRef.current + OVERSCAN_PX - HEAD_H;

  const ticks: number[] = [];
  for (let s = 0; s <= durationSec; s += TICK_SEC) ticks.push(s);

  return (
    <div className="rpt-gcd">
      <div className="rpt-gcd-head">
        <span className="rpt-card-label">GCD 模式 · 每 GCD 谁做了什么</span>
        <span className="rpt-gcd-legend">▮ 大招</span>
        {onCompactChange && (
          <span className="rpt-mode-seg rpt-gcd-density">
            {(
              [
                [false, "标准"],
                [true, "紧凑"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={label}
                className={compact === v ? "active" : ""}
                onClick={() => onCompactChange(v)}
              >
                {label}
              </button>
            ))}
          </span>
        )}
        <span className="rpt-gcd-sub">与地图共享时间轴</span>
      </div>

      <div className="rpt-gcd-chips">
        {orderedTracks.map((tr) => (
          <button
            key={tr.unitId}
            className={
              selUnits[tr.unitId] ? "rpt-gcd-chip active" : "rpt-gcd-chip"
            }
            onClick={() => onToggle(tr.unitId)}
          >
            <Dot track={tr} />
            {tr.name}
          </button>
        ))}
      </div>

      {/* 窗口跳转 chips(P1-6):deriveVulnBands 金色小 chips,点击共享时钟同跳 */}
      {onSeekT && (bands?.length ?? 0) > 0 && (
        <div className="rpt-gcd-bands">
          {bands!.map((b, i) => {
            const fromMs = source.startTime + b.fromS * 1000;
            return (
              <button
                key={i}
                className="rpt-gcd-band-chip"
                onClick={() => onSeekT(fromMs)}
                title="点击定位(地图同步)"
              >
                {mmss(Math.max(0, (fromMs - startTime) / 1000))}{" "}
                {b.kind === "burst" ? "击杀尝试" : "脆弱"} →{" "}
                {b.targetName.split("-")[0]}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="rpt-gcd-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        // 可滚动区域必须能用键盘聚焦,否则只能靠鼠标滚 —— 键盘用户到不了
        tabIndex={0}
        role="group"
        aria-label="GCD 泳道(可滚动)"
        style={{ maxHeight: VIEWPORT_H }}
      >
        <div className="rpt-gcd-body" style={{ height: contentH + HEAD_H }}>
          {/* 时间轴 */}
          <div className="rpt-gcd-axis" style={{ height: contentH + HEAD_H }}>
            {ticks.map((s) => (
              <span
                key={s}
                className="rpt-gcd-tick"
                style={{ top: HEAD_H + s * PX_PER_SEC }}
              >
                {mmss(s)}
              </span>
            ))}
          </div>

          {/* 每玩家一列;友/敌交界插分隔竖线(列体 = LaneBody memo 边界) */}
          <LaneBody
            cols={cols}
            laidByUnit={laidByUnit}
            contentH={contentH}
            compact={compact}
            flash={flash ?? null}
            tQ={tQ}
            playing={playing}
            startTime={startTime}
            winFrom={winFrom}
            winTo={winTo}
            friendlyColCount={friendlyColCount}
            hasSeek={!!onSeekT}
            hasDeathClick={!!onDeathClick}
            onSeek={stableSeek}
            onDeath={stableDeath}
            yFor={yFor}
          />

          {/* 共享时间光标(留在 memo 边界外:60Hz 平滑,reconcile 只有 2 个元素) */}
          <div
            className="rpt-gcd-cursor"
            style={{ top: HEAD_H + Math.min(contentH, Math.max(0, yFor(t))) }}
          >
            {/* 右端时间徽标(1f) */}
            <span className="rpt-gcd-cursor-badge">
              {mmss(Math.max(0, (t - startTime) / 1000))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
