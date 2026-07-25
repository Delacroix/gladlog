import { useCallback, useEffect, useMemo, useRef } from "react";

import { classColor, classGlyph } from "../data/gameConstants";
import { deriveCasts, deriveGcdCasts, isMajorCd } from "../derive/casts";
import { clusterGcdCasts } from "../derive/gcdCluster";
import type { ReplayTrack } from "../derive/replay";
import type { ReportSource } from "../derive/types";
import { SpellIcon } from "./SpellIcon";

const PX_PER_SEC = 16;
const GCD_MS = 1500;
const TICK_SEC = 5; // 1f:刻度从 15s 加密到 5s(背景另有每 5s 分隔线)
const HEAD_H = 30; // 列头高度,时间轴/光标需下移这么多以对齐列体
const CHIP_H = 23;
/** 折叠行里内联显示的小图标上限,超出收进 +N。 */
const MAX_MINIS = 3;
const VIEWPORT_H = 620; // 泳道可视高度(超出纵向滚动)

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
  flash?: {
    tMs: number;
    unitNames: string[];
    nonce: number;
  } | null;
  /** 点 chip → 共享时钟 seek 到该施法时刻(两栏同步)。 */
  onSeekT?: (tMs: number) => void;
  /** 点阵亡 divider → 死亡回顾。 */
  onDeathClick?: (unitId: string, tMs: number) => void;
}) {
  const durationSec = Math.max(1, (endTime - startTime) / 1000);
  const laneH = durationSec * PX_PER_SEC;
  // useCallback:布局 useMemo 依赖它,裸箭头每帧新身份会再次让 memo 失效。
  const yFor = useCallback(
    (ts: number): number => ((ts - startTime) / 1000) * PX_PER_SEC,
    [startTime],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

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

  // 播放时让光标保持在视口 ~40% 处
  useEffect(() => {
    if (!playing || !scrollRef.current) return;
    const el = scrollRef.current;
    const cursorY = HEAD_H + yFor(t);
    el.scrollTop = cursorY - el.clientHeight * 0.4;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, playing]);

  // 证据链跳转:新 flash 请求时滚到目标时刻(暂停态也生效)
  useEffect(() => {
    if (!flash || !scrollRef.current) return;
    const el = scrollRef.current;
    el.scrollTop = HEAD_H + yFor(flash.tMs) - el.clientHeight * 0.4;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.nonce]);

  const ticks: number[] = [];
  for (let s = 0; s <= durationSec; s += TICK_SEC) ticks.push(s);

  return (
    <div className="rpt-gcd">
      <div className="rpt-gcd-head">
        <span className="rpt-card-label">GCD 模式 · 每 GCD 谁做了什么</span>
        <span className="rpt-gcd-legend">▮ 大招</span>
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

      <div
        className="rpt-gcd-scroll"
        ref={scrollRef}
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

          {/* 每玩家一列;友/敌交界插分隔竖线 */}
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
                <div className="rpt-gcd-col">
                  <div
                    className={
                      dead ? "rpt-gcd-col-head dead" : "rpt-gcd-col-head"
                    }
                  >
                    <Dot track={tr} />
                    <span className="rpt-gcd-col-name">{tr.name}</span>
                  </div>
                  <div
                    className="rpt-gcd-col-body"
                    style={{ height: contentH }}
                  >
                    {(laidByUnit[tr.unitId] ?? []).map(({ cl, y }, i) => {
                      const c = cl.primary;
                      const members = [c, ...cl.minis];
                      const elapsed = c.t <= t;
                      const recent = elapsed && c.t >= t - GCD_MS;
                      const major = members.some((m) => isMajorCd(m.spellId));
                      // 证据链闪金:任一成员时刻 ±2s 内,且(无点名 or 本列被点名)。
                      const flashed =
                        !!flash &&
                        members.some(
                          (m) => Math.abs(m.t - flash.tMs) <= 2000,
                        ) &&
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
                      const fmtT = (ms: number) => {
                        const sec = Math.max(0, (ms - startTime) / 1000);
                        return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
                      };
                      const title =
                        members
                          .map(
                            (m) =>
                              `${fmtT(m.t)} ${m.spellName}${m.targetName ? ` → ${m.targetName}` : ""}`,
                          )
                          .join("\n") + (onSeekT ? "\n(点击定位)" : "");
                      const visMinis = cl.minis.slice(0, MAX_MINIS);
                      const extra = cl.minis.length - visMinis.length;
                      return (
                        <div
                          key={flashed ? `${i}-f${flash.nonce}` : i}
                          className={onSeekT ? `${cls} seekable` : cls}
                          style={{ top: y, left: 4, right: 4, zIndex: 1 }}
                          onClick={onSeekT ? () => onSeekT(c.t) : undefined}
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
                          <span className="rpt-gcd-act-name">
                            {c.spellName}
                          </span>
                          {visMinis.map((m, j) => (
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
                          {extra > 0 && (
                            <span className="rpt-gcd-mini-more">+{extra}</span>
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
                          onDeathClick
                            ? "rpt-gcd-death rpt-gcd-death-click"
                            : "rpt-gcd-death"
                        }
                        style={{ top: yFor(tr.deathT) }}
                        onClick={
                          onDeathClick
                            ? () => onDeathClick(tr.unitId, tr.deathT!)
                            : undefined
                        }
                        title={onDeathClick ? "点击看死亡回顾" : undefined}
                      >
                        阵亡
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* 共享时间光标 */}
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
