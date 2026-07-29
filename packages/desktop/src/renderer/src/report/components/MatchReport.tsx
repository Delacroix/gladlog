import { useEffect, useMemo, useRef, useState } from "react";

import { ensureAnalysisData } from "@gladlog/analysis";

import { bridge } from "../../bridge";

import { buildWindowAnalysisRequest } from "../derive/analysisInput";
import { deriveAuraUptime } from "../derive/auraUptime";
import { deriveBurstLedger } from "../derive/burstLedger";
import { type DeathRecap, deriveDeathRecaps } from "../derive/deathRecap";
import { deriveDispelDash } from "../derive/dispelDash";
import { deriveKickDash } from "../derive/kickDash";
import type { MeterMode } from "../derive/meterRows";
import { deriveMistakes } from "../derive/mistakes";
import { deriveStatsTable } from "../derive/statsTable";
import { deriveSummary } from "../derive/summary";
import { deriveTimeline } from "../derive/timeline";
import { buildReportMarkdown } from "../derive/exportReport";
import { rangeDurationS, type TimeRange } from "../derive/timeRange";
import type { ReportSource } from "../derive/types";
import { deriveVulnBands } from "../derive/vulnWindows";
import { makeRichText } from "../derive/inlineRich";
import { AuraUptimeCard } from "./AuraUptimeCard";
import { BurstLedgerCard } from "./BurstLedgerCard";
import { DeathRecapCard } from "./DeathRecapCard";
import { DispelDashboard } from "./DispelDashboard";
import { EventsPanel } from "./EventsPanel";
import { KickDashboard } from "./KickDashboard";
import { Meters } from "./Meters";
import { MistakesCard } from "./MistakesCard";
import { ProComparisonVerified } from "./ProComparisonVerified";
import { ReplayView } from "./ReplayView";
import { ReportHeader } from "./ReportHeader";
import { StructuredAnalysisPanel } from "./StructuredAnalysisPanel";
import { Timeline } from "./Timeline";
import { TimeRangeBar } from "./TimeRangeBar";
import { WindowAnalysisCard, type WindowCardState } from "./WindowAnalysisCard";
import { WindowList } from "./WindowList";

type View = "report" | "replay" | "events" | "ai";

const VIEW_LABEL: Record<View, string> = {
  report: "战报",
  replay: "回放",
  events: "事件",
  ai: "AI 分析",
};

export function MatchReport({
  source,
  roundLabel,
  matchId,
  initialView = "report",
  initialTimeRange = null,
}: {
  source: ReportSource;
  roundLabel?: string;
  matchId?: string;
  initialView?: View;
  /** 初始时间窗(视觉场景 report-window 用;交互入口是拖选/phase 下拉)。 */
  initialTimeRange?: TimeRange | null;
}) {
  const [mode, setMode] = useState<MeterMode>("damage");
  const [view, setView] = useState<View>(initialView);
  // 时间窗联动(第四阶段①):null = 全场。聚合面板吃窗口;HP 曲线/窗口列表/
  // 死亡回顾/爆发账本/回放保持全场口径(见 plan 文档的口径表)。
  const [timeRange, setTimeRange] = useState<TimeRange | null>(
    initialTimeRange,
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  // 证据链跳转请求:AI 视图点「回放此刻」→ 切回放并 seek。nonce 防重复消费,
  // 回放时钟保持 ReplayView 局部(提升热 state 会让三视图随 tick 重渲)。
  const [seekReq, setSeekReq] = useState<{
    tMs: number;
    unitNames: string[];
    nonce: number;
  } | null>(null);
  // B2 溯源请求:finding →「原始事件」→ 切事件视图并预置 ±15s + 单位过滤
  const [inspectReq, setInspectReq] = useState<{
    fromS: number;
    toS: number;
    unitName: string | null;
    nonce: number;
  } | null>(null);

  const handleInspectEvents = (tSeconds: number, unitNames: string[]) => {
    setInspectReq({
      fromS: Math.max(0, tSeconds - 15),
      toS: tSeconds + 15,
      unitName: unitNames[0]?.split("-")[0] ?? null,
      nonce: Date.now(),
    });
    setView("events");
  };
  const handleSeekEvent = (tSeconds: number, unitNames: string[]) => {
    setSeekReq({
      tMs: source.startTime + tSeconds * 1000,
      unitNames,
      nonce: Date.now(),
    });
    setView("replay");
  };
  const summary = useMemo(
    () => deriveSummary(source, timeRange),
    [source, timeRange],
  );
  const timeline = useMemo(() => deriveTimeline(source), [source]);
  const statsRows = useMemo(
    () => deriveStatsTable(source, timeRange),
    [source, timeRange],
  );
  const vulnBands = useMemo(() => deriveVulnBands(source), [source]);
  const ledgerPlayers = useMemo(() => deriveBurstLedger(source), [source]);
  const kickRows = useMemo(
    () => deriveKickDash(source, timeRange),
    [source, timeRange],
  );
  const dispelDash = useMemo(
    () => deriveDispelDash(source, timeRange),
    [source, timeRange],
  );
  const auraUptime = useMemo(
    () => deriveAuraUptime(source, timeRange),
    [source, timeRange],
  );
  // 失误清单:全场 derive 一次(标记要画全场),卡片按窗口过滤
  const mistakesAll = useMemo(() => deriveMistakes(source), [source]);
  const mistakes = useMemo(
    () =>
      timeRange
        ? mistakesAll.filter(
            (mk) => mk.tS >= timeRange.fromS && mk.tS <= timeRange.toS,
          )
        : mistakesAll,
    [mistakesAll, timeRange],
  );
  const [recap, setRecap] = useState<DeathRecap | null>(null);
  // P1-3:进战报/换场默认展开最近一次死亡回顾(友方优先)。effect 每场只跑
  // 一次(ref 记忆),用户 ✕ 关闭后本场不再自动打开;derive 惰性,不进渲染路径。
  const autoRecapKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${source.startTime}:${source.endTime}`;
    if (autoRecapKey.current === key) return;
    autoRecapKey.current = key;
    setRecap(null);
    const all = deriveDeathRecaps(source);
    if (all.length === 0) return;
    const friendly = all.filter(
      (r) =>
        (source.units[r.unitId] as { info?: { teamId?: number } } | undefined)
          ?.info?.teamId === source.playerTeamId,
    );
    const pool = friendly.length > 0 ? friendly : all;
    setRecap(pool.reduce((a, b) => (b.deathS > a.deathS ? b : a)));
  }, [source]);
  // 回放光标投影(1c):从回放切回战报时显示最后位置
  const [lastReplayT, setLastReplayT] = useState<number | null>(null);
  // AI 一键同跑:分析主按钮 nonce → cohort 对比(合并两个按钮)
  const [aiRunNonce, setAiRunNonce] = useState(0);

  // 选段分析(#16):一次性深挖当前拖选窗口,终态卡挂在工具条下方。
  const [winAi, setWinAi] = useState<{
    range: TimeRange;
    state: WindowCardState;
  } | null>(null);
  // timeRange 变化(含被清除)即收卡:同一窗口(值相等)保留在飞/终态,
  // 换窗口或清窗口一律收起(不自动重查,用户需再次点按钮)。
  useEffect(() => {
    setWinAi((prev) =>
      prev &&
      timeRange &&
      prev.range.fromS === timeRange.fromS &&
      prev.range.toS === timeRange.toS
        ? prev
        : null,
    );
  }, [timeRange]);

  // 教练回复语言(同 ProComparisonVerified 的 settings.get 模式):
  // bridge 面可能缺(fixture 桩/测试台),try/catch 兜底默认 zh。
  const [aiLang, setAiLang] = useState<"zh" | "en">("zh");
  useEffect(() => {
    void (async () => {
      try {
        const s = await bridge().settings.get();
        if (s?.aiLanguage === "en" || s?.aiLanguage === "zh")
          setAiLang(s.aiLanguage);
      } catch {
        /* 默认 zh */
      }
    })();
  }, []);
  // 点击流程先 await 了 ensureAnalysisData()(见 runWindowAi),结果渲染时
  // 名字索引必已就绪 —— 不需要 StructuredAnalysisPanel 那种 dataReady 门。
  const rich = useMemo(() => makeRichText(source, aiLang), [source, aiLang]);

  const runWindowAi = async (range: TimeRange) => {
    setWinAi({ range, state: { phase: "loading" } });
    await ensureAnalysisData(); // 构包前置契约:prompt 法术名不许降级
    const req = buildWindowAnalysisRequest(source, range.fromS, range.toS);
    if (!req) {
      setWinAi({ range, state: { phase: "none" } }); // 门不过,不发 IPC
      return;
    }
    try {
      const r = await bridge().analysis.analyzeWindow({
        matchId: resolvedMatchId,
        fromS: range.fromS,
        toS: range.toS,
        pack: req.pack,
        kind: req.kind,
        spec: req.spec,
        ownerName: req.ownerName,
      });
      if (r.status === "ok")
        setWinAi({
          range,
          state: {
            phase: "result",
            text: r.text,
            chips: r.chips,
            fromCache: r.fromCache,
          },
        });
      else if (r.status === "busy") {
        // 在飞:保持 loading,结果由先前调用落缓存后用户再点回显
        return;
      } else setWinAi({ range, state: { phase: r.status } });
    } catch {
      setWinAi({ range, state: { phase: "error" } }); // 无桥/异常同可重试待遇
    }
  };

  // 死亡标记点击 → 找该单位最近的回顾(懒算,点击才 derive)。
  // 回顾只有一个家:战报右栏常驻位(2026-07-26 用户反馈浮层与常驻栏重复)——
  // 从回放/事件点进来时切回战报视图展示,不再弹浮层。
  const openRecap = (unitId: string, tMs: number) => {
    const tS = (tMs - source.startTime) / 1000;
    const all = deriveDeathRecaps(source);
    const hit = all
      .filter((r) => r.unitId === unitId)
      .sort((a, b) => Math.abs(a.deathS - tS) - Math.abs(b.deathS - tS))[0];
    if (hit) {
      setRecap(hit);
      setView("report");
    }
  };

  const toggleUnit = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const resolvedMatchId = matchId ?? source.id;

  return (
    <div className="rpt-match">
      {/* 页头一行:视图 tab 靠左(用户反馈),胜负+meta 靠右 */}
      <div className="rpt-head-row">
        <div className="rpt-view-tabs rpt-head-tabs">
          {(Object.keys(VIEW_LABEL) as View[]).map((k) => (
            <button
              key={k}
              className={k === view ? "active" : ""}
              onClick={() => setView(k)}
            >
              {VIEW_LABEL[k]}
            </button>
          ))}
        </div>
        <ReportHeader source={source} roundLabel={roundLabel} />
      </div>
      {view === "report" && (
        <div className="rpt-body">
          {/* 主卡:生命曲线 + 窗口列表(1c);时间窗工具条(第四阶段①) */}
          <div>
            <div className="rpt-toolbar-row">
              <TimeRangeBar
                bands={vulnBands}
                range={timeRange}
                onChange={setTimeRange}
              />
              {timeRange && (
                <button
                  className="rpt-btn"
                  data-testid="window-ai-btn"
                  title="对当前选段做一次 AI 深挖(无可教信号时不调用模型)"
                  onClick={() => void runWindowAi(timeRange)}
                >
                  AI 分析此段
                </button>
              )}
              <button
                className="rpt-btn rpt-export-report"
                title="导出当前(窗口)口径的战报 Markdown"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    buildReportMarkdown(source, timeRange),
                  )
                }
              >
                复制 Markdown
              </button>
              <button
                className="rpt-btn rpt-export-image"
                title="导出战报图片(离屏渲染同一页面后整页截图)"
                onClick={() => {
                  try {
                    void bridge().matches.exportImage({
                      matchId: resolvedMatchId,
                      roundSeq:
                        source.kind === "shuffleRound"
                          ? source.sequenceNumber
                          : null,
                      range: timeRange,
                    });
                  } catch {
                    /* fixture/测试台无桥 → 静默 */
                  }
                }}
              >
                导出图片
              </button>
            </div>
            {winAi && (
              <WindowAnalysisCard
                state={winAi.state}
                range={winAi.range}
                rich={rich}
                onJumpT={handleSeekEvent}
                onRetry={() => void runWindowAi(winAi.range)}
              />
            )}
            <Timeline
              data={timeline}
              hidden={hidden}
              onSelectUnit={toggleUnit}
              onDeathClick={openRecap}
              bands={vulnBands}
              onBandClick={(tS) => handleSeekEvent(tS, [])}
              cursorT={lastReplayT}
              range={timeRange}
              onRangeSelect={(fromS, toS) => setTimeRange({ fromS, toS })}
              marks={mistakesAll}
              onMarkClick={(tS) => handleSeekEvent(Math.max(0, tS - 3), [])}
            />
            <WindowList bands={vulnBands} onSeek={handleSeekEvent} />
          </div>
          {/* 下方两栏:榜单 | 死亡回顾常驻栏(1c) */}
          <div className="rpt-body-cols">
            <Meters
              rows={summary}
              mode={mode}
              onMode={setMode}
              playerTeamId={source.playerTeamId}
              hidden={hidden}
              onToggleUnit={toggleUnit}
              statsRows={statsRows}
              durationS={rangeDurationS(source, timeRange)}
              onSeek={handleSeekEvent}
              source={source}
              range={timeRange}
            />
            <div className="rpt-recap-col">
              {recap ? (
                <DeathRecapCard
                  recap={recap}
                  onClose={() => setRecap(null)}
                  onJump={(tSeconds, unitNames) => {
                    handleSeekEvent(tSeconds, unitNames);
                  }}
                />
              ) : (
                <div className="rpt-recap-placeholder">
                  点击曲线上的 ✕ 查看死亡回顾
                </div>
              )}
            </div>
          </div>
          <MistakesCard mistakes={mistakes} onSeek={handleSeekEvent} />
          <BurstLedgerCard players={ledgerPlayers} onSeek={handleSeekEvent} />
          <KickDashboard rows={kickRows} onSeek={handleSeekEvent} />
          <DispelDashboard dash={dispelDash} onSeek={handleSeekEvent} />
          <AuraUptimeCard data={auraUptime} range={timeRange} />
        </div>
      )}
      {view === "events" && (
        <EventsPanel
          source={source}
          bands={vulnBands}
          globalRange={timeRange}
          onSeek={handleSeekEvent}
          inspectReq={inspectReq}
          matchId={resolvedMatchId}
          onOpenRecap={openRecap}
        />
      )}
      {view === "replay" && (
        <ReplayView
          source={source}
          seekReq={seekReq}
          onDeathClick={openRecap}
          onLastT={setLastReplayT}
        />
      )}
      {view === "ai" && (
        <div className="rpt-ai-full">
          <div className="rpt-ai-main">
            <StructuredAnalysisPanel
              source={source}
              matchId={resolvedMatchId}
              onSeekEvent={handleSeekEvent}
              onInspectEvents={handleInspectEvents}
              onRunAll={() => setAiRunNonce((n) => n + 1)}
            />
            <div className="rpt-ai-cohort">
              <ProComparisonVerified
                source={source}
                matchId={resolvedMatchId}
                runSignal={aiRunNonce}
                hideActions
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
