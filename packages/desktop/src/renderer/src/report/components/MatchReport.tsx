import { useEffect, useMemo, useRef, useState } from "react";

import { ensureAnalysisData } from "@gladlog/analysis";

import { bridge } from "../../bridge";

import { buildWindowAnalysisRequest } from "../derive/analysisInput";
import { deriveAuraUptime } from "../derive/auraUptime";
import { deriveBurstLedger } from "../derive/burstLedger";
import { deriveCCChainDash } from "../derive/ccChainDash";
import { deriveDampeningSeries } from "../derive/dampeningSeries";
import { type DeathRecap, deriveDeathRecaps } from "../derive/deathRecap";
import { deriveDispelDash } from "../derive/dispelDash";
import { deriveKickDash } from "../derive/kickDash";
import { deriveMatchArc } from "../derive/matchArc";
import type { MeterMode } from "../derive/meterRows";
import { deriveMistakes, timedAnchorsFromMistakes } from "../derive/mistakes";
import { derivePressureLanes } from "../derive/pressureLanes";
import { deriveStatsTable } from "../derive/statsTable";
import { deriveSummary } from "../derive/summary";
import { deriveTimeline } from "../derive/timeline";
import { buildReportMarkdown } from "../derive/exportReport";
import { rangeDurationS, type TimeRange } from "../derive/timeRange";
import type { ReportSource } from "../derive/types";
import { deriveUncoveredHighlights } from "../derive/uncoveredHighlights";
import { deriveVulnBands } from "../derive/vulnWindows";
import { makeRichText } from "../derive/inlineRich";
import { BurstLedgerCard } from "./BurstLedgerCard";
import { DeathRecapCard } from "./DeathRecapCard";
import { EngagementPanel } from "./EngagementPanel";
import { EventsPanel } from "./EventsPanel";
import { KpiChips } from "./KpiChips";
import { MatchArcLine } from "./MatchArcLine";
import { Meters } from "./Meters";
import { MistakesCard } from "./MistakesCard";
import { ProComparisonVerified } from "./ProComparisonVerified";
import { ReplayView } from "./ReplayView";
import { ReportHeader } from "./ReportHeader";
import { StructuredAnalysisPanel } from "./StructuredAnalysisPanel";
import { UncoveredHighlightsCard } from "./UncoveredHighlightsCard";
import { VideoTab } from "./VideoTab";
import { Timeline } from "./Timeline";
import { TimeRangeBar } from "./TimeRangeBar";
import { WindowAnalysisCard, type WindowCardState } from "./WindowAnalysisCard";
import { WindowList } from "./WindowList";

type View = "report" | "replay" | "events" | "video" | "ai";

const VIEW_LABEL: Record<View, string> = {
  report: "战报",
  replay: "回放",
  events: "事件",
  video: "录像",
  ai: "AI 分析",
};

export function MatchReport({
  source,
  roundLabel,
  matchId,
  videoMatchId,
  ratingDelta = null,
  initialView = "report",
  initialTimeRange = null,
}: {
  source: ReportSource;
  roundLabel?: string;
  matchId?: string;
  /** 录像关联查询用的存储 id。shuffle 各轮的 matchId 是每轮内容哈希(分析
   * 缓存按轮),而录像挂在 lobby 存储 id(= 首轮 id)上 —— 不传则回退
   * matchId(普通对局两者相同)。真机踩坑:单排只有 R1 有录像。 */
  videoMatchId?: string;
  /** 评分变动(UI 改版 1a):App 层相邻两场差值,shuffle 只在末轮传。
   * log 里没有个人评分变动(ARENA_MATCH_END 只有队伍 MMR),只能靠列表
   * 上下文注入 —— 组件内部不要试图从 source 推导。 */
  ratingDelta?: number | null;
  initialView?: View;
  /** 初始时间窗(视觉场景 report-window 用;交互入口是拖选/phase 下拉)。 */
  initialTimeRange?: TimeRange | null;
}) {
  // 提前到顶部:runWindowAi 的 matchId 守卫(见下方 matchIdRef)要在闭包创建
  // 前就能读到当前值 —— 只依赖 props,不依赖任何 hook,提前算不影响其它逻辑。
  const resolvedMatchId = matchId ?? source.id;
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
  const pressure = useMemo(() => derivePressureLanes(source), [source]);
  const dampening = useMemo(() => deriveDampeningSeries(source), [source]);
  const ledger = useMemo(() => deriveBurstLedger(source), [source]);
  const kickRows = useMemo(
    () => deriveKickDash(source, timeRange),
    [source, timeRange],
  );
  const ccChainDash = useMemo(
    () => deriveCCChainDash(source, timeRange),
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
  // 比赛节奏头部行(#10 T4):全场口径,不随时间窗联动(同失误清单的全场
  // derive 惯例——头部行是「这场怎么打的」概览,不该随拖选窗口变来变去)。
  const matchArc = useMemo(() => deriveMatchArc(source), [source]);
  // KPI chips(UI 改版 1a):同为全场口径 —— kick/dispel 的窗口版在上面,
  // 这里按 [source] 单独 memo 一份不带 range 的,拖选窗口时 chips 不跳变。
  const kickFull = useMemo(() => deriveKickDash(source), [source]);
  const dispelFull = useMemo(() => deriveDispelDash(source), [source]);
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
  // BACKLOG #13:未覆盖亮点自动滑窗——AI 视图 findings 区下方的入口。
  // aiFindingAnchors 来自 StructuredAnalysisPanel(初轮 findings 的时间锚,
  // 见 onFindingsAnchors prop),与 mistakesAll 的真实时间锚拼成去重锚点
  // 集合——两处口径的拼装留在这里,derive 层(deriveUncoveredHighlights)
  // 保持纯几何、不关心锚点从哪来。timedAnchorsFromMistakes 已过滤掉
  // cd-waste 等"整场观察"类的哨兵 tS(复核轮修复:此前全量折入会把开局
  // 窗口误判为"已覆盖")。
  const [aiFindingAnchors, setAiFindingAnchors] = useState<number[]>([]);
  const uncoveredAnchors = useMemo(
    () => [...aiFindingAnchors, ...timedAnchorsFromMistakes(mistakesAll)],
    [aiFindingAnchors, mistakesAll],
  );
  // 懒算(判断,非硬门槛):只在 AI 视图挂载时才跑滑窗。全场
  // buildWindowAnalysisRequest 循环有确定性成本(90s/9 窗实测 <30ms,见
  // uncoveredHighlights.test.ts 的性能记录),量级不算重,但更长对局窗口数
  // 线性增长,且 report/replay/events 视图的用户不该为一张可能根本不看的
  // 卡片买单——保守按 view 门控,不预先算。
  const uncoveredHighlights = useMemo(
    () =>
      view === "ai"
        ? deriveUncoveredHighlights(
            source,
            rangeDurationS(source),
            uncoveredAnchors,
          )
        : [],
    [source, uncoveredAnchors, view],
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
  // 关联录像(有才显示「录像」tab)。桩经常缺 recorder 面 —— 缺面静默无 tab。
  const [videoRec, setVideoRec] = useState<{
    url: string;
    startedAt: number;
  } | null>(null);
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
  // runWindowAi 的异步间隙里 timeRange 可能已变(用户拖了新窗口/清除)——
  // 收卡 effect 只清 state,不取消飞在半路的 promise;若不额外守卫,stale
  // 响应回来后仍会用旧 range 无条件 setWinAi 把已收起的卡复活(fix round 1
  // 审查发现)。ref 与 timeRange 同步,供 runWindowAi 在每个 await 之后
  // 比对「窗口没变」才落状态(同 StructuredAnalysisPanel 的 cancelled 守卫
  // 思路,这里比的是值而非布尔量,因为窗口可能变了又变回同一个值)。
  const timeRangeRef = useRef(timeRange);
  useEffect(() => {
    timeRangeRef.current = timeRange;
  }, [timeRange]);
  // matchId 版同一守卫(fix:审计 Critical——Shuffle 换回合若复用组件实例,
  // 飞在半路的响应只比 fromS/toS,数值恰好相同就会把上一轮的分析结果落到
  // 新一轮页面上)。ShuffleReport 已加 key={round.id} 强制换轮重挂载作为
  // 主防线,这里是纵深防御:任何未来的无 key 调用方也不会中招。
  const matchIdRef = useRef(resolvedMatchId);
  useEffect(() => {
    matchIdRef.current = resolvedMatchId;
  }, [resolvedMatchId]);

  // 换局(matchId 变化)手动清理这两处真正跨局失真的 state(fix round 2,
  // 复核后从「ShuffleReport 加 key 全量重挂载」改成这里的 surgical 版——
  // 全量重挂载会把 view/videoRec 一起炸掉:用户正在看的「回放」跳回默认
  // 「战报」,且 6 轮共享同一段 videoMatchId 录像的 <video> 每次换轮都销毁
  // 重建(本该只是 seek,不该重新加载/闪烁)。
  // - timeRange:拖选/phase 下拉出的窗口是上一局的时间语义,换局后作废。
  // - winAi:选段 AI 结果原样挂着上一局内容——本次审计 Critical 的病灶本体。
  // 用 ref 记上一次的 matchId,只在它真的变化时才清(不能无条件用
  // [resolvedMatchId] 触发就清,否则首次挂载也会跑一遍,把调用方传入的
  // initialTimeRange 干掉——见 windowAnalysis.test.tsx / report.timerange
  // 等靠 initialTimeRange 挂载即生效的用例)。
  // 未纳入本次清理、逐一判过的其它 state:
  // - hidden:隐藏哪个单位是跨局稳定的用户偏好(同一批玩家在 shuffle 各轮
  //   反复出现),继续隐藏是预期行为,不是「失真」。
  // - lastReplayT:是绝对 ms 值,但 Timeline 已有
  //   `cursorT >= data.start && cursorT <= data.end` 自身范围守卫——换局后
  //   几乎必然落在新局区间外,自然不渲染,无需额外清。
  // - recap:已有独立 effect 按 `source.startTime:source.endTime` 换局自动
  //   重算(见上方 autoRecapKey),不依赖这里。
  // - aiLang/aiRunNonce/videoRec:aiLang 是全局设置与局无关;videoRec 按
  //   resolvedVideoId(videoMatchId,shuffle 各轮共享,不随 matchId 变)查询,
  //   不该清也不会清;aiRunNonce 只是触发计数器,不携带局内容。
  // - StructuredAnalysisPanel/ProComparisonVerified 内部状态:两者已各自用
  //   matchId 做归属核对(resultForRef 模式),不依赖父级重挂载。
  const prevMatchIdRef = useRef(resolvedMatchId);
  useEffect(() => {
    if (prevMatchIdRef.current === resolvedMatchId) return;
    prevMatchIdRef.current = resolvedMatchId;
    setTimeRange(null);
    setWinAi(null);
    // BACKLOG #13:同上——aiFindingAnchors 原样挂着上一局的 finding 时间锚,
    // StructuredAnalysisPanel 换局后会重新上报,但那是异步的(等它自己的
    // getState/lang effect 跑完);这里主动清空是纵深防御,消除"新局用旧局
    // 锚点去重"的瞬时窗口(同 timeRange/winAi 的清理动机)。
    setAiFindingAnchors([]);
  }, [resolvedMatchId]);

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

  const runWindowAi = async (range: TimeRange, opts?: { force?: boolean }) => {
    // 请求发起时的 matchId(闭包捕获,不随后续渲染变化)——isCurrent() 拿它
    // 与 matchIdRef.current 比对,防止换局/换回合后飞在半路的响应落地。
    const requestMatchId = resolvedMatchId;
    // 当前 timeRange 是否仍是本次调用发起时的那个窗口(值相等,不比引用——
    // 用户可能拖回同一个窗口)。每个 await 之后都要重查一次:窗口在任一
    // 异步间隙都可能被用户改掉/清除。matchId 不等同样视为过期——同一组件
    // 实例若被跨局复用(理论上不该发生,ShuffleReport 已加 key 杜绝,这里
    // 是纵深防御),fromS/toS 恰好相同也不能让上一局的结果落到新局。
    const isCurrent = () =>
      !!timeRangeRef.current &&
      timeRangeRef.current.fromS === range.fromS &&
      timeRangeRef.current.toS === range.toS &&
      matchIdRef.current === requestMatchId;
    setWinAi({ range, state: { phase: "loading" } });
    await ensureAnalysisData(); // 构包前置契约:prompt 法术名不许降级
    if (!isCurrent()) return; // 窗口已变/被清除:丢弃,不复活已收起的卡
    const req = buildWindowAnalysisRequest(source, range.fromS, range.toS);
    if (!req) {
      setWinAi({ range, state: { phase: "none" } }); // 门不过,不发 IPC
      return;
    }
    // 夹后窗口(req.fromS/toS):发往 main 的载荷与结果卡标题都要用它——pack
    // 是按夹后边界构建的,若仍报调用方传入的原始 range.fromS/toS,越界窗口
    // 会让卡片标题与实际分析的证据窗对不上。isCurrent() 的守卫逻辑不变,
    // 仍比对本次调用的原始 range(闭包变量),不受此影响。
    const evidenceRange = { fromS: req.fromS, toS: req.toS };
    try {
      const r = await bridge().analysis.analyzeWindow({
        matchId: resolvedMatchId,
        fromS: evidenceRange.fromS,
        toS: evidenceRange.toS,
        pack: req.pack,
        kind: req.kind,
        spec: req.spec,
        ownerName: req.ownerName,
        // #21 item11 复核轮修复:audit-empty 的显式重试必须绕开缓存重新
        // 打模型(缓存只保护"重新选中同一窗口",不该吞掉用户点的重试)。
        force: opts?.force,
      });
      if (!isCurrent()) return; // 同上:异步返回时窗口可能已变
      if (r.status === "ok")
        setWinAi({
          range: evidenceRange,
          state: {
            phase: "result",
            text: r.text,
            chips: r.chips,
            fromCache: r.fromCache,
          },
        });
      else setWinAi({ range: evidenceRange, state: { phase: r.status } }); // busy/audit-empty/no-client/error 均为可重试终态
    } catch {
      if (isCurrent())
        setWinAi({ range: evidenceRange, state: { phase: "error" } }); // 无桥/异常同可重试待遇
    }
  };

  // BACKLOG #13:未覆盖亮点卡点击【AI 分析此段】=同一次点击里"设窗 + 触发
  // runWindowAi"。timeRangeRef 平时靠 effect 跟随 timeRange 异步同步,但
  // runWindowAi 的 isCurrent() 守卫在第一个 await 之后就会读它——若还没
  // 等 effect 跑完就已经到 await 后,会误判"窗口已变",把自己刚发起的这次
  // 请求当过期丢弃。这里手动提前同步 ref 消除该竞态(setTimeRange 之后
  // effect 仍会再赋一次同样的值,幂等,不冲突)。
  const handleAnalyzeHighlight = (range: TimeRange) => {
    timeRangeRef.current = range;
    setTimeRange(range);
    void runWindowAi(range);
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

  const resolvedVideoId = videoMatchId ?? resolvedMatchId;

  useEffect(() => {
    let alive = true;
    setVideoRec(null);
    try {
      void bridge()
        .recorder?.getForMatch(resolvedVideoId)
        .then((r) => {
          if (alive) setVideoRec(r);
        })
        .catch(() => {});
    } catch {
      /* 桩缺面 */
    }
    return () => {
      alive = false;
    };
  }, [resolvedVideoId]);

  return (
    <div className="rpt-match">
      {/* 页头一行:视图 tab 靠左(用户反馈),胜负+meta 靠右 */}
      <div className="rpt-head-row">
        <div className="rpt-view-tabs rpt-head-tabs">
          {(Object.keys(VIEW_LABEL) as View[])
            .filter((k) => k !== "video" || videoRec != null)
            .map((k) => (
              <button
                key={k}
                className={k === view ? "active" : ""}
                onClick={() => setView(k)}
              >
                {VIEW_LABEL[k]}
              </button>
            ))}
        </div>
        <ReportHeader
          source={source}
          roundLabel={roundLabel}
          ratingDelta={ratingDelta}
        />
      </div>
      {/* 比赛节奏头部行(#10 T4):影响全部 report-* 场景,挂在头部行下、
          view 切换之上,不随 tab 消失。 */}
      <MatchArcLine phases={matchArc} onSeek={handleSeekEvent} />
      {view === "report" && (
        <div className="rpt-body">
          {/* KPI chips 行(UI 改版 1a):全场口径速览,恒不随时间窗联动 */}
          <KpiChips
            timeline={timeline}
            mistakes={mistakesAll}
            bands={vulnBands}
            kickRows={kickFull}
            dispelDash={dispelFull}
            onSeek={handleSeekEvent}
          />
          {/* 双栏工作台(1a):≥1440px 左=曲线/榜单/账本 右=死亡回顾/失误;
              窄窗口自动回退单列(grid 由 CSS 断点控制,组件树不变) */}
          <div className="rpt-report-grid">
            <div className="rpt-col-main">
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
                    onRetry={() =>
                      void runWindowAi(winAi.range, {
                        // 仅 audit-empty 的重试需要绕开缓存(#21 item11 复核轮
                        // 修复):error/busy 从未落盘缓存,force 对它们是 no-op,
                        // 但只在确实需要时传,别让语义在别的分支上产生误解。
                        force: winAi.state.phase === "audit-empty",
                      })
                    }
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
                  pressure={pressure}
                  dampening={dampening}
                />
                <WindowList bands={vulnBands} onSeek={handleSeekEvent} />
              </div>
              {/* 左列两栏:榜单 | 对局面板(打断/驱散/光环/CC链 四 tab 合一) */}
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
                <EngagementPanel
                  kickRows={kickRows}
                  dispelDash={dispelDash}
                  auraUptime={auraUptime}
                  ccRows={ccChainDash.rows}
                  onSeek={handleSeekEvent}
                  range={timeRange}
                />
              </div>
              <BurstLedgerCard
                players={ledger.players}
                targetSelection={ledger.targetSelection}
                onSeek={handleSeekEvent}
              />
            </div>
            {/* 右列:死亡回顾常驻 + 失误清单(1a) */}
            <div className="rpt-col-side">
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
              <MistakesCard mistakes={mistakes} onSeek={handleSeekEvent} />
            </div>
          </div>
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
          matchId={videoMatchId ?? resolvedMatchId}
        />
      )}
      {view === "video" && videoRec && (
        <VideoTab
          url={videoRec.url}
          startedAt={videoRec.startedAt}
          source={source}
          matchId={resolvedMatchId}
          timeline={timeline}
          bands={vulnBands}
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
              onFindingsAnchors={setAiFindingAnchors}
            />
            <UncoveredHighlightsCard
              highlights={uncoveredHighlights}
              onAnalyze={handleAnalyzeHighlight}
            />
            {/* 亮点卡点击后的结果卡:同一份 winAi state/组件(报告视图工具条
                下方那张),AI 视图内点了亮点也要能就地看到结果,不用切
                「战报」tab —— 否则「一键接 #16」等于没接。 */}
            {winAi && (
              <WindowAnalysisCard
                state={winAi.state}
                range={winAi.range}
                rich={rich}
                onJumpT={handleSeekEvent}
                onRetry={() =>
                  void runWindowAi(winAi.range, {
                    force: winAi.state.phase === "audit-empty",
                  })
                }
              />
            )}
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
