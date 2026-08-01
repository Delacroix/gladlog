import { useEffect, useMemo, useState } from "react";
import { zoneMetadata } from "@gladlog/analysis";
import { interpolate } from "@gladlog/analysis/src/compare/claimChecker";
import { distillFacts } from "@gladlog/analysis/src/learning/distillRules";
import { habitBadgeText } from "@gladlog/analysis/src/learning/matchRules";
import {
  PATTERN_WINDOW_MATCHES,
  PATTERN_MIN_HITS,
  TREND_BUCKET_MATCHES,
} from "@gladlog/analysis/src/learning/patternScan";
import type {
  LearnedRule,
  RulesDoc,
} from "@gladlog/analysis/src/learning/types";

import type { StoredMatchMeta } from "../../../main/matchStore";
import type { LearningState } from "../../../main/learning";
import { bridge } from "../bridge";
import { specName } from "../report/data/gameConstants";
import { categoryLabel } from "../report/derive/findingDisplay";
import { SpecDot } from "./MatchListRow";
import {
  type DashPeriod,
  deriveCurrentRating,
  deriveDashboard,
  listCharacters,
  periodStart,
} from "./dashboard";

const PERIOD_LABEL: Record<DashPeriod, string> = {
  today: "今天",
  week: "7 天",
  all: "全部",
};

const SERIES_COLORS = ["#d9a842", "#60a5fa", "#34d399", "#f472b6"];

/** 系列色(1h):3v3 = accent、Solo Shuffle = win,其余顺延旧色板。 */
const seriesColor = (bracket: string, i: number): string =>
  bracket === "3v3"
    ? "var(--accent)"
    : /shuffle/i.test(bracket)
      ? "var(--win)"
      : SERIES_COLORS[i % SERIES_COLORS.length]!;

const fmtMD = (t: number): string => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const winPct = (wins: number, games: number): string =>
  games > 0 ? `${Math.round((100 * wins) / games)}%` : "—";

const winCls = (wins: number, games: number): string =>
  games === 0 ? "" : wins * 2 >= games ? "dash-win" : "dash-loss";

function RatingCurve({
  series,
}: {
  series: ReturnType<typeof deriveDashboard>["ratingSeries"];
}) {
  const W = 760;
  const H = 160;
  const PAD = { l: 44, r: 10, t: 10, b: 16 };
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) {
    return <p className="dash-empty">评分数据不足(需要含评分的对局 ≥2 场)。</p>;
  }
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  const r0 = Math.min(...all.map((p) => p.rating));
  const r1 = Math.max(...all.map((p) => p.rating));
  const pad = Math.max(20, (r1 - r0) * 0.1);
  const x = (t: number): number =>
    PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (r: number): number =>
    H -
    PAD.b -
    ((r - (r0 - pad)) / (r1 + pad - (r0 - pad))) * (H - PAD.t - PAD.b);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="dash-curve"
      data-testid="dash-curve"
    >
      {/* y 轴三档 + x 轴日期刻度(1h) */}
      {[r0, (r0 + r1) / 2, r1].map((r) => (
        <g key={r}>
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(r)}
            y2={y(r)}
            className="rpt-tl-grid"
          />
          <text x={4} y={y(r) + 4} className="rpt-tl-axis">
            {Math.round(r)}
          </text>
        </g>
      ))}
      {[t0, (t0 + t1) / 2, t1].map((t, i) => (
        <text
          key={i}
          x={x(t)}
          y={H - 2}
          className="rpt-tl-axis"
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
        >
          {fmtMD(t)}
        </text>
      ))}
      {series.map((s, i) => {
        const color = seriesColor(s.bracket, i);
        const last = s.points[s.points.length - 1]!;
        return (
          <g key={s.bracket}>
            <path
              fill="none"
              stroke={color}
              strokeWidth={1.6}
              d={s.points
                .map(
                  (p, j) =>
                    `${j === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.rating).toFixed(1)}`,
                )
                .join(" ")}
            />
            {s.points.map((p, j) => (
              <circle key={j} cx={x(p.t)} cy={y(p.rating)} r={2} fill={color}>
                <title>{`${s.bracket} · ${Math.round(p.rating)} · ${new Date(p.t).toLocaleString()}`}</title>
              </circle>
            ))}
            {/* 端点圆 + 当前分标注 */}
            <circle cx={x(last.t)} cy={y(last.rating)} r={3.5} fill={color} />
            <text
              x={x(last.t) + 5}
              y={y(last.rating) + 3.5}
              className="dash-series-label"
              fill={color}
            >
              {Math.round(last.rating)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 44px 评分 sparkline(1e):KPI 塔「当前评分」卡内,点开弹 RatingCurve 大图。
 * 纯趋势示意 —— 无轴无文字,preserveAspectRatio=none 拉伸无碍。 */
function RatingSparkline({
  points,
  color,
}: {
  points: { t: number; rating: number }[];
  color: string;
}) {
  if (points.length < 2) return null;
  const W = 240;
  const H = 44;
  const P = 3;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const r0 = Math.min(...points.map((p) => p.rating));
  const r1 = Math.max(...points.map((p) => p.rating));
  const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
  const y = (r: number) =>
    H - P - ((r - r0) / Math.max(1, r1 - r0)) * (H - 2 * P);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="dash-spark"
      data-testid="dash-sparkline"
      aria-hidden="true"
    >
      <path
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        d={points
          .map(
            (pt, i) =>
              `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.rating).toFixed(1)}`,
          )
          .join(" ")}
      />
      <circle
        cx={x(t1)}
        cy={y(points[points.length - 1]!.rating)}
        r={2.5}
        fill={color}
      />
    </svg>
  );
}

/**
 * 战绩仪表盘(phase3 #1 → 1e 改版):左 KPI 塔(270px)+ 右教练卡双栏。
 * 整行评分曲线卡撤销,曲线收进「当前评分」sparkline 的点开弹层;
 * 错题本 + 长期规律合并为「这周该练什么」一张卡。comp 行点击 → 回对局
 * 列表预置该 spec 筛选。
 */
interface NotebookEntry {
  matchId: string;
  flagKey: string;
  flag: string | null;
  title: string;
  explanation: string;
  severity: string;
  startTime: number;
  zoneId?: string;
  result?: string;
  bracket?: string;
}
interface NotebookGroup {
  category: string;
  count: number;
  recurring: number;
  done: number;
  entries: NotebookEntry[];
}

export function StatsDashboard({
  onCompClick,
  onOpenMatch,
}: {
  /** comp 行点击:带该 comp 首个 specId 回列表筛选。 */
  onCompClick?: (specId: number) => void;
  /** 「最常犯的问题」最近实例点击 → 打开该场。 */
  onOpenMatch?: (matchId: string) => void;
}) {
  const [metas, setMetas] = useState<StoredMatchMeta[]>([]);
  const [period, setPeriod] = useState<DashPeriod>("week");
  // 角色筛选(多角色玩家的战绩区分;undefined = 全部)
  const [character, setCharacter] = useState<string | undefined>(undefined);
  const [notebook, setNotebook] = useState<NotebookGroup[]>([]);
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const [rulesDoc, setRulesDoc] = useState<RulesDoc | null>(null);
  const [learnState, setLearnState] = useState<LearningState | null>(null);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [learnError, setLearnError] = useState<string | null>(null);
  // 评分曲线大图弹层(1e):sparkline 点开
  const [curveOpen, setCurveOpen] = useState(false);
  const reloadLearning = () => {
    try {
      const api = (
        bridge() as unknown as {
          learning?: {
            getRules(): Promise<RulesDoc | null>;
            getState(): Promise<LearningState>;
          };
        }
      ).learning;
      if (!api) return;
      void api
        .getRules()
        .then(setRulesDoc)
        .catch(() => {});
      void api
        .getState()
        .then(setLearnState)
        .catch(() => {});
    } catch {
      /* 测试桩无该面 */
    }
  };

  useEffect(() => {
    reloadLearning();
    try {
      const api = (
        bridge() as unknown as {
          learning?: {
            onDone(cb: (d: { distillError?: string }) => void): () => void;
            onProgress(
              cb: (p: { scanned: number; total: number }) => void,
            ): () => void;
            onError(cb: (d: { message: string }) => void): () => void;
          };
        }
      ).learning;
      if (!api) return undefined;
      const offDone = api.onDone?.((d) => {
        setDistillError(d.distillError ?? null);
        setLearnError(null);
        reloadLearning();
      });
      const offProgress = api.onProgress?.((p) => {
        setLearnState((s) =>
          s
            ? { ...s, backfill: { running: true, ...p } }
            : {
                backfill: { running: true, ...p },
                consolidating: false,
                ledgerMatches: 0,
                badLines: 0,
                lastConsolidatedAt: null,
              },
        );
      });
      const offError = api.onError?.((d) => {
        setLearnError(d.message);
      });
      return () => {
        offDone?.();
        offProgress?.();
        offError?.();
      };
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    const refresh = () => {
      void bridge()
        .matches.list()
        .then((all) => setMetas(all))
        .catch(() => {});
      // 错题本一并重取:入库常伴随分析缓存变化
      try {
        void bridge()
          .analysis.notebook()
          .then(setNotebook)
          .catch(() => setNotebook([]));
      } catch {
        setNotebook([]);
      }
    };
    refresh();
    // 战绩随入库动态更新(backlog #12):watcher 补历史/实时入库时不再停留在
    // mount 时的快照。防抖合并批量入库(历史导入一次涌入几百场)。
    let timer: ReturnType<typeof setTimeout> | null = null;
    let un: (() => void) | undefined;
    try {
      un = bridge().logs.onMatchStored(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 500);
      });
    } catch {
      /* 测试桩无 logs 面 */
    }
    return () => {
      if (timer) clearTimeout(timer);
      un?.();
    };
  }, []);

  const flagEntry = (e: NotebookEntry, flag: "done" | "recurring") => {
    const next = e.flag === flag ? null : flag;
    // 稳定键匹配(matchId+flagKey = 后端 setFlag 的键语义):引用相等会在
    // IPC 未决期间的刷新/连点后失配,UI 与落盘状态脱钩(agy 复核 #1)
    const isTarget = (x: NotebookEntry) =>
      x.matchId === e.matchId && x.flagKey === e.flagKey;
    try {
      void bridge()
        .analysis.setFlag(e.matchId, e.flagKey, next)
        .then(() =>
          setNotebook((groups) =>
            groups.map((g) => ({
              ...g,
              recurring: g.entries.filter((x) =>
                isTarget(x) ? next === "recurring" : x.flag === "recurring",
              ).length,
              done: g.entries.filter((x) =>
                isTarget(x) ? next === "done" : x.flag === "done",
              ).length,
              entries: g.entries.map((x) =>
                isTarget(x) ? { ...x, flag: next } : x,
              ),
            })),
          ),
        )
        .catch(() => {});
    } catch {
      /* 测试桩无该面 */
    }
  };

  const characters = useMemo(() => listCharacters(metas), [metas]);
  const dash = useMemo(
    () => deriveDashboard(metas, period, Date.now(), character),
    [metas, period, character],
  );
  const cur = useMemo(
    () =>
      deriveCurrentRating(metas, periodStart(period, Date.now()), character),
    [metas, period, character],
  );

  return (
    <div className="dash" data-testid="stats-dashboard">
      {/* 标题行(1h):战绩 + 角色 chips + 右端时间段控 */}
      <div className="dash-head">
        <span className="dash-title">战绩</span>
        {characters.length >= 2 && (
          <div className="dash-chars" data-testid="dash-chars">
            <button
              className={character === undefined ? "active" : ""}
              onClick={() => setCharacter(undefined)}
            >
              全部角色
            </button>
            {characters.map((c) => (
              <button
                key={c.name}
                className={c.name === character ? "active" : ""}
                onClick={() => setCharacter(c.name)}
                title={`${c.games} 场`}
              >
                {c.name.split("-")[0]}
                <span className="dash-chars-n">{c.games}</span>
              </button>
            ))}
          </div>
        )}
        <div className="rpt-mode-seg dash-period">
          {(Object.keys(PERIOD_LABEL) as DashPeriod[]).map((p) => (
            <button
              key={p}
              className={p === period ? "active" : ""}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {/* 1e 双栏:左 KPI 塔(270px)+ 右教练卡列;整行曲线卡撤销 */}
      <div className="dash-grid">
        <div className="dash-kpi-col" data-testid="dash-band">
          <div className="dash-kpi-card">
            <span className="dash-kpi-v">{dash.games}</span>
            <span className="dash-kpi-k">场次</span>
          </div>
          <div className="dash-kpi-card">
            <span
              className="dash-kpi-v"
              style={
                dash.rateGames > 0 && dash.rateWins * 2 >= dash.rateGames
                  ? { color: "#a8e6c4" }
                  : undefined
              }
            >
              {winPct(dash.rateWins, dash.rateGames)}
            </span>
            <span className="dash-kpi-k">
              胜率 · {dash.rateWins}-{dash.rateGames - dash.rateWins}
              {dash.rateGames !== dash.games ? "(按回合)" : ""}
            </span>
          </div>
          <div className="dash-kpi-card">
            <span className="dash-kpi-v">
              {cur ? (
                <>
                  {cur.rating}
                  {cur.delta != null && cur.delta !== 0 && (
                    <span className="dash-band-sub">
                      {" "}
                      {cur.delta > 0 ? "↑" : "↓"}
                      {Math.abs(cur.delta)}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </span>
            <span className="dash-kpi-k">
              当前评分{cur ? `(${cur.bracket})` : ""}
            </span>
            {cur &&
              (() => {
                const idx = dash.ratingSeries.findIndex(
                  (sr) => sr.bracket === cur.bracket,
                );
                const pts = idx >= 0 ? dash.ratingSeries[idx]!.points : [];
                return pts.length >= 2 ? (
                  <button
                    type="button"
                    className="dash-spark-btn"
                    title="点开评分曲线大图"
                    aria-label="展开评分曲线大图"
                    onClick={() => setCurveOpen(true)}
                  >
                    <RatingSparkline
                      points={pts}
                      color={seriesColor(cur.bracket, Math.max(0, idx))}
                    />
                  </button>
                ) : null;
              })()}
          </div>
          <div className="dash-kpi-card">
            <span className="dash-kpi-v">
              {dash.medianDurationS != null
                ? `${Math.floor(dash.medianDurationS / 60)}:${String(
                    Math.floor(dash.medianDurationS % 60),
                  ).padStart(2, "0")}`
                : "—"}
            </span>
            <span className="dash-kpi-k">时长中位</span>
          </div>
        </div>
        <div className="dash-main-col">
          {(notebook.length > 0 || rulesDoc || learnState) && (
            <div className="dash-card" data-testid="dash-practice">
              <span className="dash-card-head">
                <span className="rpt-card-label">
                  这周该练什么 —— 错题本 + 长期规律(1e 合卡)
                </span>
                {(rulesDoc || learnState) && (
                  <>
                    <button
                      className="dash-learning-run"
                      disabled={learnState?.consolidating}
                      onClick={() => {
                        try {
                          void (
                            bridge() as unknown as {
                              learning?: { consolidate(): Promise<void> };
                            }
                          ).learning?.consolidate();
                        } catch {
                          /* noop */
                        }
                      }}
                    >
                      {learnState?.consolidating ? "整合中…" : "重新整合"}
                    </button>
                  </>
                )}
              </span>
              {/* 「按影响排序」:两源无共同量纲(错题=频次,规律=趋势状态),
              采用结构性排序 —— 跨局稳定规律在前(高影响),错题按频次殿后;
              不发明合成分数。 */}
              {(rulesDoc || learnState) && (
                <div data-testid="dash-learning">
                  <p className="dash-learning-meta">
                    {learnState?.backfill?.running
                      ? `回填历史分析中… ${learnState.backfill.scanned}/${learnState.backfill.total}`
                      : `台账 ${learnState?.ledgerMatches ?? 0} 场` +
                        (learnState?.lastConsolidatedAt
                          ? ` · 上次整合 ${new Date(learnState.lastConsolidatedAt).toLocaleString()}`
                          : " · 尚未整合")}
                    {learnState && learnState.badLines > 0
                      ? ` · ${learnState.badLines} 坏行已跳过`
                      : ""}
                    {distillError
                      ? ` · AI 提炼失败(仅缺文本):${distillError}`
                      : ""}
                    {learnError ? ` · 整合失败:${learnError}` : ""}
                  </p>
                  {(rulesDoc?.rules ?? []).map((r: LearnedRule) => {
                    const facts = distillFacts(r.stats);
                    const desc = r.description.zh ?? r.description.en;
                    const adv = r.advice.zh ?? r.advice.en;
                    const max = Math.max(1, ...r.stats.trend);
                    return (
                      <div key={r.ruleId} className="dash-learning-rule">
                        <span
                          className={`dash-learning-status ${r.status}`}
                          title={
                            r.status === "improved"
                              ? "近期已明显减少 —— 进步证据,继续保持"
                              : "仍在活跃发生"
                          }
                        >
                          {r.status === "improved" ? "已改进" : "活跃"}
                        </span>
                        <span className="dash-learning-cat">
                          {categoryLabel(r.category, "zh")}
                          {r.eventTypes.length > 0
                            ? ` · ${r.eventTypes.join("+")}`
                            : ""}
                          {r.condition?.enemySpec
                            ? `(对位 spec ${r.condition.enemySpec})`
                            : r.condition?.zoneId
                              ? `(地图 ${r.condition.zoneId})`
                              : ""}
                        </span>
                        <span className="dash-learning-count">
                          {habitBadgeText(r, "zh")}
                        </span>
                        <span
                          className="dash-learning-trend"
                          title={`每 ${TREND_BUCKET_MATCHES} 场命中数,旧→新`}
                        >
                          {r.stats.trend.map((h, i) => (
                            <i
                              key={i}
                              style={{ height: `${4 + (h / max) * 12}px` }}
                              className={h > 0 ? "hit" : ""}
                            />
                          ))}
                        </span>
                        <p className="dash-learning-desc">
                          {desc
                            ? interpolate(desc, facts)
                            : "(描述待下次整合生成)"}
                        </p>
                        {adv && (
                          <p className="dash-learning-advice">
                            💡 {interpolate(adv, facts)}
                          </p>
                        )}
                        <span className="dash-learning-evidence">
                          {r.evidence.map((id) => (
                            <button key={id} onClick={() => onOpenMatch?.(id)}>
                              查看战例
                            </button>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                  {(rulesDoc?.rules ?? []).length === 0 &&
                    !learnState?.backfill?.running && (
                      <p className="dash-learning-empty">
                        还没有稳定模式 —— 分析的对局多了(同类问题近{" "}
                        {PATTERN_WINDOW_MATCHES} 场出现 {PATTERN_MIN_HITS}{" "}
                        次以上)会自动出现在这里。
                      </p>
                    )}
                </div>
              )}
              {notebook.length > 0 && (
                <div data-testid="dash-notebook">
                  {notebook.map((g) => {
                    const open = !!openCats[g.category];
                    return (
                      <div key={g.category} className="dash-nb-group">
                        <button
                          className="dash-nb-head"
                          onClick={() =>
                            setOpenCats((o) => ({
                              ...o,
                              [g.category]: !o[g.category],
                            }))
                          }
                        >
                          <span className="dash-nb-caret">
                            {open ? "▼" : "▸"}
                          </span>
                          {/* 显示走中文词表(枚举 slug/历史自由词均归一);聚合键不动 */}
                          <span className="dash-nb-cat">
                            {categoryLabel(g.category, "zh")}
                          </span>
                          <span className="dash-nb-count">×{g.count}</span>
                          {g.recurring > 0 && (
                            <span className="dash-issue-rec">
                              ↻ {g.recurring}
                            </span>
                          )}
                          {g.done > 0 && (
                            <span className="dash-issue-done">✓ {g.done}</span>
                          )}
                        </button>
                        {open &&
                          g.entries.map((e, i) => (
                            <div
                              key={`${e.matchId}:${e.flagKey}:${i}`}
                              className="dash-nb-entry"
                            >
                              <span className="dash-nb-when">
                                {new Date(e.startTime).getMonth() + 1}/
                                {new Date(e.startTime).getDate()}
                              </span>
                              <span className="dash-nb-meta">
                                {e.zoneId
                                  ? (zoneMetadata[e.zoneId]?.name ??
                                    e.bracket ??
                                    "")
                                  : (e.bracket ?? "")}
                                {e.result
                                  ? ` · ${e.result.toLowerCase() === "win" ? "胜" : "负"}`
                                  : ""}
                              </span>
                              <span
                                className={`dash-nb-sev rpt-finding-${e.severity}`}
                              >
                                <span className="rpt-finding-sev">
                                  {e.severity}
                                </span>
                              </span>
                              <span
                                className="dash-nb-title"
                                title={e.explanation}
                              >
                                {e.title}
                              </span>
                              <span className="dash-nb-actions">
                                <button
                                  className={e.flag === "done" ? "active" : ""}
                                  title="标记为已改进"
                                  onClick={() => flagEntry(e, "done")}
                                >
                                  ✓
                                </button>
                                <button
                                  className={
                                    e.flag === "recurring" ? "active rec" : ""
                                  }
                                  title="标记为还在犯"
                                  onClick={() => flagEntry(e, "recurring")}
                                >
                                  ↻
                                </button>
                                {onOpenMatch && (
                                  <button
                                    className="dash-issue-recent"
                                    onClick={() => onOpenMatch(e.matchId)}
                                  >
                                    打开该场 →
                                  </button>
                                )}
                              </span>
                            </div>
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="dash-tables">
            <div className="dash-card">
              <span className="rpt-card-label">对阵敌方阵容</span>
              <div className="dash-comps">
                {dash.comps.slice(0, 12).map((c) => {
                  const pct = c.games > 0 ? (100 * c.wins) / c.games : 0;
                  const barColor =
                    pct >= 55
                      ? "var(--win)"
                      : pct <= 45
                        ? "var(--loss)"
                        : "#9397ab";
                  return (
                    <div
                      key={c.specIds.join("+")}
                      className={
                        onCompClick ? "dash-comp dash-comp-click" : "dash-comp"
                      }
                      onClick={
                        onCompClick && c.specIds.length > 0
                          ? () => onCompClick(c.specIds[0]!)
                          : undefined
                      }
                      title={c.specIds.map((id) => specName(id)).join(" + ")}
                    >
                      <span className="dash-comp-specs">
                        {c.specIds.map((id, i) => (
                          <SpecDot key={i} specId={id} classId={0} />
                        ))}
                      </span>
                      <span className="dash-comp-track">
                        <span
                          className="dash-comp-bar"
                          style={{ width: `${pct}%`, background: barColor }}
                        />
                      </span>
                      <span
                        className="dash-comp-num"
                        style={{ color: barColor }}
                      >
                        {winPct(c.wins, c.games)}
                        <span className="dash-comp-games"> · {c.games}场</span>
                      </span>
                    </div>
                  );
                })}
                {dash.comps.length === 0 && (
                  <div className="dash-empty">无阵容数据。</div>
                )}
              </div>
              <div className="dash-comp-foot">
                点击行回列表筛选该阵容
                {dash.legacyRows > 0 &&
                  ` · 另有 ${dash.legacyRows} 场旧数据无阵容(开发者视图可重建索引回填)`}
              </div>
            </div>

            <div className="dash-card">
              <span className="rpt-card-label">分地图</span>
              <table className="rpt-stats">
                <tbody>
                  {dash.zones.slice(0, 12).map((z) => (
                    <tr key={z.zoneId}>
                      <td>
                        {zoneMetadata[z.zoneId]?.name ?? `zone ${z.zoneId}`}
                      </td>
                      <td>{z.games} 场</td>
                      <td className={winCls(z.wins, z.games)}>
                        {winPct(z.wins, z.games)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* 评分曲线大图弹层(1e):sparkline 点开;点背景/✕ 关闭 */}
      {curveOpen && (
        <div
          className="dash-modal-backdrop"
          onClick={() => setCurveOpen(false)}
        >
          <div
            className="dash-modal"
            role="dialog"
            aria-label="评分曲线"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="dash-card-head">
              <span className="rpt-card-label">
                评分曲线(
                {character
                  ? `${character.split("-")[0]} 本人`
                  : "本人评分,旧数据回退队均"}
                )
              </span>
              <span className="dash-legend">
                {dash.ratingSeries.map((sr, i) => (
                  <span key={sr.bracket} className="dash-legend-item">
                    <span
                      className="dash-legend-line"
                      style={{ background: seriesColor(sr.bracket, i) }}
                    />
                    {sr.bracket}
                  </span>
                ))}
              </span>
              <button
                type="button"
                className="dash-modal-close"
                aria-label="关闭"
                onClick={() => setCurveOpen(false)}
              >
                ✕
              </button>
            </span>
            <RatingCurve series={dash.ratingSeries} />
          </div>
        </div>
      )}
    </div>
  );
}

export { periodStart };
