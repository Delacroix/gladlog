import type { Finding } from "@gladlog/analysis";
import { analysisDataReady, ensureAnalysisData } from "@gladlog/analysis";
import {
  habitBadgeText,
  ruleAppliesToFinding,
} from "@gladlog/analysis/src/learning/matchRules";
import type { LearnedRule } from "@gladlog/analysis/src/learning/types";
import { useEffect, useMemo, useRef, useState } from "react";

import { bridge } from "../../bridge";
import { buildAnalysisInput, buildDeepenPacks } from "../derive/analysisInput";
import { categoryLabel, severityLabel } from "../derive/findingDisplay";
import { resolveJumpTarget } from "../derive/jumpTarget";
import { deriveKeyMoments } from "../derive/keyMoments";
import type { ReportSource } from "../derive/types";
import { ExportButtons } from "./ExportButtons";
import { FindingsList } from "./FindingsList";
import { KeyMomentAxis } from "./KeyMomentAxis";

type AnalysisResult = {
  findings: Finding[];
  dropped: number;
  hadNarration: boolean;
  fallbackReason?: "no-candidates" | "no-client" | "bad-json";
  deepened?: boolean;
};

/** 0 finding 的中文解释(按回退原因/审计丢弃区分,不再用统一英文提示)。 */
function zeroFindingText(r: AnalysisResult): string {
  if (r.dropped > 0)
    return `模型输出了 ${r.dropped} 条,但全部未通过审计(裸数字/编造事件/因果断言)被丢弃 —— 可点「重新分析」再试。`;
  switch (r.fallbackReason) {
    case "no-candidates":
      return "本场无可指摘事件(无人阵亡、资源使用无明显问题)—— 这是好事,不硬编教练意见。";
    case "no-client":
      return "未配置 AI(设置里填 API key 或本地 CLI 后端),仅展示确定性事件。";
    case "bad-json":
      return "模型返回格式异常,已回退为确定性展示 —— 可点「重新分析」再试。";
    default:
      return "未生成解说(旧版本缓存),点「重新分析」重新生成。";
  }
}

type State = "idle" | "running" | "done" | "error";

export function StructuredAnalysisPanel({
  source,
  matchId,
  onSeekEvent,
  onInspectEvents,
  onRunAll,
}: {
  source: ReportSource;
  matchId: string;
  /** 证据链跳转:切到回放并定位到 t(秒,自 combat start)。 */
  onSeekEvent?: (tSeconds: number, unitNames: string[]) => void;
  /** B2 溯源:跳 events 视图并预置过滤(finding →「原始事件」)。 */
  onInspectEvents?: (tSeconds: number, unitNames: string[]) => void;
  /** 合并按钮(用户反馈):主按钮同时触发 cohort 对比。 */
  onRunAll?: () => void;
}) {
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  // result 归属的 matchId:切场瞬间 result 仍是旧场数据,深挖触发必须核对
  // 归属,否则会把 A 场 findings 写进 B 场缓存(agy 复核 #1)
  const resultForRef = useRef<string | null>(null);
  const [error, setError] = useState<string>("");
  const [, setActiveEventIds] = useState<string[]>([]);
  // 教练回复语言(backlog #1):持久化在 settings,main 侧按它注入 system
  // prompt 并分键缓存;这里只需在切换后重查缓存。
  const [lang, setLang] = useState<"zh" | "en" | null>(null);
  const [flags, setFlags] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState("");
  // 本场目标(D3 闭环):跨场标记「还在犯」的 top 分类,作为本场观察目标。
  const [goals, setGoals] = useState<
    Array<{ category: string; recurring: number; lastTitle?: string }>
  >([]);
  // 跨对局惯性徽章(spec §4):规则台账,匹配审计后 findings,不调 AI。
  const [rules, setRules] = useState<LearnedRule[]>([]);
  useEffect(() => {
    try {
      const api = (
        bridge() as unknown as {
          learning?: { getRules(): Promise<{ rules: LearnedRule[] } | null> };
        }
      ).learning;
      if (!api) return;
      void api
        .getRules()
        .then((doc) => setRules(doc?.rules ?? []))
        .catch(() => {});
    } catch {
      /* 测试桩无该面 */
    }
  }, [matchId]);

  useEffect(() => {
    try {
      const p = bridge().analysis.aggregate?.();
      if (!p) return;
      void p
        .then((cats) =>
          setGoals(
            (cats ?? [])
              .filter((c) => c.recurring > 0)
              .sort((a, b) => b.recurring - a.recurring)
              .slice(0, 3)
              .map((c) => ({
                category: c.category,
                recurring: c.recurring,
                lastTitle: c.recent?.[0]?.title,
              })),
          ),
        )
        .catch(() => {});
    } catch {
      /* 测试桩无该面 */
    }
  }, [matchId]);

  useEffect(() => {
    // cancelled 守卫:flags 是**按场**的数据,快速切场时先发的请求可能后到,
    // 把上一场的标记盖到当前场上(标记会渲染成 finding 上的「还在犯/已解决」,
    // 张冠李戴)。与上面 getState 那个 effect 同款写法。
    let cancelled = false;
    try {
      void bridge()
        .analysis.getFlags(matchId)
        .then((f) => {
          if (!cancelled) setFlags(f);
        })
        .catch(() => {
          if (!cancelled) setFlags({});
        });
    } catch {
      setFlags({});
    }
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  const handleFlag = (key: string, flag: "done" | "recurring" | null) => {
    try {
      void bridge()
        .analysis.setFlag(matchId, key, flag)
        .then(setFlags)
        .catch(() => {});
    } catch {
      /* 测试桩无该面 */
    }
  };

  useEffect(() => {
    // 测试桩/旧 fixture bridge 可能没有 settings 面 —— 静默回退默认中文
    try {
      void bridge()
        .settings.get()
        .then((s) =>
          setLang((s as { aiLanguage?: "zh" | "en" }).aiLanguage ?? "zh"),
        )
        .catch(() => setLang("zh"));
    } catch {
      setLang("zh");
    }
  }, []);

  const switchLang = async (next: "zh" | "en") => {
    if (next === lang || state === "running") return;
    setLang(next);
    try {
      await bridge().settings.save({ aiLanguage: next });
    } catch {
      /* 无 settings 面(测试桩)时仅本地切换 */
    }
  };

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    resultForRef.current = null;
    setState("idle");
    setError("");
    setActiveEventIds([]);
    void (async () => {
      try {
        // 单次原子查询:缓存与 running 必须在主进程一次读出。分两次问
        // (getCached → isRunning)会在两次 await 之间漏掉恰好此刻完成的那轮 ——
        // 缓存还没落盘、running 已经清了,面板停在空闲态而结果已在盘上。
        const { cached, running } = (await bridge().analysis.getState(
          matchId,
        )) as { cached: AnalysisResult | null; running: boolean };
        if (cancelled) return;
        if (cached) {
          resultForRef.current = matchId;
          setResult(cached);
          setState("done");
        } else if (running) {
          // 重挂时(切 tab/切场回来)若首轮还在主进程跑,显示「分析中…」而非
          // 空闲态 —— 否则用户以为丢了、再点一次会重复跑。done 事件回来时补上结果。
          setState("running");
        }
      } catch {
        /* 测试桩/无 bridge 面:保持空闲 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId, lang]);

  useEffect(() => {
    // 常驻挂载后此 effect 在任何视图下都跑;bridge 面缺席(测试桩)不能让挂载抛。
    let offDelta: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    let offError: (() => void) | undefined;
    try {
      const ai = bridge().analysis;
      offDelta = ai.onDelta?.((d: { matchId: string; text: string }) => {
        if (d.matchId !== matchId) return;
        setPreview((p) => (p + d.text).slice(-600));
      });
      offDone = ai.onDone((d: { matchId: string; result: unknown }) => {
        if (d.matchId !== matchId) return;
        resultForRef.current = matchId;
        setResult(d.result as AnalysisResult);
        setState("done");
        setError("");
      });
      offError = ai.onError((d: { matchId: string; message: string }) => {
        if (d.matchId !== matchId) return;
        setState("error");
        setError(d.message);
      });
    } catch {
      /* 测试桩/无 bridge 面:不订阅,挂载不抛 */
    }
    return () => {
      offDelta?.();
      offDone?.();
      offError?.();
    };
  }, [matchId]);

  // 大数据表(法术名/天赋)是后台加载的;提示词不许降级(契约见 analysis
  // 的 data/ensure.ts),所以 input 构建以就绪为门。正常时序下表在报表
  // 打开前早已就绪(analysisDataReady() 初值即 true,零额外重渲)。
  const [dataReady, setDataReady] = useState(analysisDataReady);
  useEffect(() => {
    if (dataReady) return;
    let alive = true;
    void ensureAnalysisData().then(() => {
      if (alive) setDataReady(true);
    });
    return () => {
      alive = false;
    };
  }, [dataReady]);

  // 构建逻辑与批量驱动器同源(analysisInput.ts)—— DPS 记录者走 DPS 视角(D2)。
  const input = useMemo(() => {
    if (!dataReady) return null;
    return buildAnalysisInput(source, matchId);
  }, [source, matchId, dataReady]);

  const keyMoments = useMemo(() => deriveKeyMoments(source), [source]);

  // 跨对局惯性徽章:zoneId 在 renderer 侧未知 → 传 undefined,zone 条件规则
  // 保守不亮(matchInCondition 对未知字段判不满足,见 Task 1)。
  const habitOf = useMemo(() => {
    if (rules.length === 0 || !input) return undefined;
    const meta = { enemySpecs: input.enemySpecs };
    return (f: Finding): string | null => {
      const hit = rules.find((r) =>
        ruleAppliesToFinding(r, f, input.candidates, meta),
      );
      return hit ? habitBadgeText(hit, lang ?? "zh") : null;
    };
  }, [rules, input, lang]);

  // 深挖轮(自动追问):初轮结果落地后,为高严重度 finding 构建确定性证据包
  // 并触发第二轮。deepened 标志防重;包为空时也调用一次以落标志。
  useEffect(() => {
    if (!result || !input) return;
    if (resultForRef.current !== matchId) return; // 切场瞬间的旧 result
    if (!result.hadNarration || result.deepened) return;
    if (result.findings.length === 0) return;
    try {
      // 构包逻辑与批量驱动器同源(analysisInput.ts)
      const packs = buildDeepenPacks(
        source,
        result.findings,
        input.candidates,
        input.ownerName,
      );
      void bridge()
        .analysis.deepen({
          matchId,
          findings: result.findings,
          packs,
          spec: input.spec,
          ownerName: input.ownerName,
        })
        .catch(() => {});
    } catch {
      /* 测试桩无该面 / 构包失败:保持初轮 */
    }
    // input 必须在依赖里:dataReady 门会让它 null→非 null,缓存命中场景下
    // result 先就绪、effect 首跑时 input 还是 null 直接 return —— 不依赖
    // input 的话深挖永远不触发(agy 复核 F1)。重跑无害:main 侧幂等守卫
    // + deepened 标志双保险。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, matchId, input]);

  // 分流谓词与 buildFindingsPrompt 的 whole-round 判定同源:
  // facts.t 缺席 = 整场观察(cd-waste 等),不进时间轴。
  const splitFindings = useMemo(() => {
    const timedIds = new Set(
      (input?.candidates ?? [])
        .filter((c) => c.facts.t !== undefined)
        .map((c) => c.id),
    );
    const timed = (result?.findings ?? []).filter((f) =>
      f.eventIds?.some((id) => timedIds.has(id)),
    );
    const wholeRound = (result?.findings ?? []).filter(
      (f) => !timed.includes(f),
    );
    return { timed, wholeRound };
  }, [input, result]);

  // finding 的 eventIds → 引用事件里最早的 t + 涉及单位(查表在 derive 层,
  // 那里有单测 —— 播种式的 E2E 撞不上真实候选 id,覆盖不到这条路径)。
  const handleJump = (eventIds: string[]) => {
    if (!onSeekEvent || !input) return;
    const target = resolveJumpTarget(input.candidates, eventIds);
    if (!target) return;
    setActiveEventIds(eventIds);
    onSeekEvent(target.t, target.unitNames);
  };

  const handleAnalyze = async () => {
    if (!input) return;
    setError("");
    setPreview("");
    setState("running");
    onRunAll?.(); // 一键同跑 cohort 对比
    await bridge().analysis.run(input);
  };

  const buttonText =
    state === "running" ? "分析中…" : state === "done" ? "重新分析" : "AI 分析";

  return (
    <div className="rpt-ai-panel">
      {/* 操作区置顶(1g):主按钮 + 语言段控 + 状态文字 + 右端导出。
          未分析时(无 result)主按钮作醒目居中大 CTA;出结果后回落紧凑行。 */}
      <div
        className={`rpt-ai-actions rpt-ai-actions-top${
          result ? "" : " rpt-ai-actions-hero"
        }`}
      >
        <button
          className="rpt-ai-primary"
          onClick={handleAnalyze}
          disabled={!input || state === "running"}
        >
          {buttonText}
        </button>
        <div className="rpt-ai-lang" title="教练回复语言">
          {(["zh", "en"] as const).map((l) => (
            <button
              key={l}
              className={l === lang ? "active" : ""}
              disabled={state === "running"}
              onClick={() => void switchLang(l)}
            >
              {l === "zh" ? "中文" : "EN"}
            </button>
          ))}
        </div>
        {result && (
          <span className="rpt-ai-status">
            已缓存 · {result.findings.length} 条 findings
            {result.findings[0]?.severity
              ? ` · 最高严重度 ${severityLabel(result.findings[0].severity, lang ?? "zh")}`
              : ""}
          </span>
        )}
        {result && (
          <span className="rpt-ai-export">
            <ExportButtons
              findings={result.findings}
              heroText={`${result.findings.length} findings`}
            />
          </span>
        )}
      </div>
      {goals.length > 0 && (
        <div className="rpt-ai-goals" data-testid="ai-goals">
          <span className="rpt-ai-goals-title">
            本场目标 —— 你标记过「还在犯」的问题:
          </span>
          {goals.map((g) => (
            <span key={g.category} className="rpt-ai-goal">
              ↻{g.recurring} {categoryLabel(g.category, lang ?? "zh")}
              {g.lastTitle ? `(上次:${g.lastTitle})` : ""}
            </span>
          ))}
        </div>
      )}
      {error && <div className="rpt-ai-error">{error}</div>}

      {result && (
        <div className="rpt-ai-body">
          {result.hadNarration === false ? (
            <div>
              <KeyMomentAxis
                moments={keyMoments}
                findings={[]}
                candidates={input?.candidates ?? []}
                onSeek={onSeekEvent}
                onSelectEvidence={setActiveEventIds}
                lang={lang ?? "zh"}
                habitOf={habitOf}
              />
              <p
                data-testid="zero-finding-reason"
                style={{
                  color: "var(--mute)",
                  fontSize: "12px",
                  marginBottom: "12px",
                }}
              >
                {zeroFindingText(result)}
              </p>
              <FindingsList
                findings={[]}
                onSelect={setActiveEventIds}
                habitOf={habitOf}
              />
            </div>
          ) : (
            <>
              <KeyMomentAxis
                moments={keyMoments}
                findings={splitFindings.timed}
                candidates={input?.candidates ?? []}
                onSeek={onSeekEvent}
                onSelectEvidence={setActiveEventIds}
                flags={flags}
                onFlag={handleFlag}
                lang={lang ?? "zh"}
                habitOf={habitOf}
              />
              {splitFindings.wholeRound.length > 0 && (
                <>
                  <h4 className="rpt-axis-wholeround-label">整场观察</h4>
                  <FindingsList
                    findings={splitFindings.wholeRound}
                    onSelect={setActiveEventIds}
                    onJump={onSeekEvent ? handleJump : undefined}
                    onJumpT={onSeekEvent}
                    onInspect={onInspectEvents}
                    candidates={input?.candidates ?? []}
                    flags={flags}
                    onFlag={handleFlag}
                    lang={lang ?? "zh"}
                    habitOf={habitOf}
                  />
                </>
              )}
            </>
          )}
        </div>
      )}

      {state === "running" && preview && (
        <pre className="rpt-ai-preview" data-testid="ai-preview">
          {preview}
        </pre>
      )}
    </div>
  );
}
