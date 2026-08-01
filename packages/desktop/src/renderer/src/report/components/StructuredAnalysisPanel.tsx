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
import { makeRichText } from "../derive/inlineRich";
import { resolveJumpTarget } from "../derive/jumpTarget";
import { deriveKeyMoments } from "../derive/keyMoments";
import { slotLabel } from "../derive/slotLabel";
import type { ReportSource } from "../derive/types";
import {
  AI_BACKENDS,
  AI_MODELS,
  BACKEND_CLI_TOOL,
  resolveAiModel,
  type AiBackend,
} from "../../../../shared/aiModels";
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
  // 多模型槽(Task 3):slots/activeKey 来自 getState 摘要;selectedSlotKey
  // 为 null 表示「跟随 activeKey」(默认/新分析完成后的行为)。
  const [slots, setSlots] = useState<
    Array<{ key: string; createdAt: number; stale: boolean }>
  >([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // activeKey 的 ref 镜像:handleSelectSlot 的 getCached resolve 回调需要
  // "此刻的" activeKey 判断刚取到的槽是否就是激活槽,而回调是在点击那一刻
  // 的渲染里创建的闭包——若在 await 期间 activeKey 状态更新(如并发的
  // onDone),闭包里的 activeKey 会是旧值。ref 保证读到的是最新值。
  const activeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  // tab 切换是普通点击而非 effect,没有 cleanup 可挂 cancelled 标志;记住
  // "这次点击请求的是哪个槽",getCached resolve 时若已经点了别的槽/换场,
  // 丢弃这份迟到的响应(避免 A/B 连点时旧响应盖掉新点的结果)。
  const slotRequestRef = useRef<string | null>(null);
  // "当前 result 状态是不是激活槽的内容"—— 与每次 setResult 同步写入(而非
  // 从 selectedSlotKey/activeKey 派生),避免这类竞态(agy flash 复核 F1):
  // 点击切回激活槽的 tab 后,selectedSlotKey/displayedSlotKey 立即翻新,
  // 但 result payload 要等 getCached resolve 才真的换成新槽内容;若深挖
  // 门槛只看 displayedSlotKey===activeKey,会在这个中间态里把上一槽的
  // result.findings 深挖进激活槽。
  const resultOwnerRef = useRef<"active" | "other">("active");
  const displayedSlotKey = selectedSlotKey ?? activeKey;
  // 教练回复语言(backlog #1):持久化在 settings,main 侧按它注入 system
  // prompt 并分键缓存;这里只需在切换后重查缓存。
  const [lang, setLang] = useState<"zh" | "en" | null>(null);
  // split 按钮菜单(Task 4)用的 settings 快照:仅取哨兵字段(key 真值)与
  // 当前全局默认 backend/model,不重复请求——复用下面 lang 那次 settings.get()。
  const [aiSettings, setAiSettings] = useState<{
    anthropicApiKey?: string | null;
    deepseekApiKey?: string | null;
    aiBackend?: AiBackend | null;
    aiModels?: Partial<Record<AiBackend, string>> | null;
  } | null>(null);
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
    // 测试桩/旧 fixture bridge 可能没有 settings 面 —— 静默回退默认中文。
    // 同一次 settings.get() 顺带取 split 菜单要的字段(Task 4),不重复请求。
    try {
      void bridge()
        .settings.get()
        .then((s) => {
          setLang((s as { aiLanguage?: "zh" | "en" }).aiLanguage ?? "zh");
          setAiSettings(
            s as {
              anthropicApiKey?: string | null;
              deepseekApiKey?: string | null;
              aiBackend?: AiBackend | null;
              aiModels?: Partial<Record<AiBackend, string>> | null;
            },
          );
        })
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
    // 切场/切语言:回到「跟随 activeKey」,槽摘要待下面查询回填。
    setSelectedSlotKey(null);
    slotRequestRef.current = null;
    resultOwnerRef.current = "active";
    setSlots([]);
    setActiveKey(null);
    void (async () => {
      try {
        // 单次原子查询:缓存与 running 必须在主进程一次读出。分两次问
        // (getCached → isRunning)会在两次 await 之间漏掉恰好此刻完成的那轮 ——
        // 缓存还没落盘、running 已经清了,面板停在空闲态而结果已在盘上。
        const {
          cached,
          running,
          slots: slotSummaries,
          activeKey: docActiveKey,
        } = (await bridge().analysis.getState(matchId)) as {
          cached: AnalysisResult | null;
          running: boolean;
          slots?: Array<{ key: string; createdAt: number; stale: boolean }>;
          activeKey?: string | null;
        };
        if (cancelled) return;
        setSlots(slotSummaries ?? []);
        setActiveKey(docActiveKey ?? null);
        if (cached) {
          resultForRef.current = matchId;
          // getState 的 cached 恒等于 resolveActiveSlot 的内容(main 侧单源
          // 判断),故这里恒为 "active",与 docActiveKey 的具体值无关。
          resultOwnerRef.current = "active";
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
      offDone = ai.onDone(
        (d: { matchId: string; result: unknown; slotKey?: string }) => {
          if (d.matchId !== matchId) return;
          resultForRef.current = matchId;
          // 不变式(Task 4 交接项修正 —— 原注释假设"完成的运行 = 设置里的
          // 默认槽",split 按钮的临时 backendOverride 打破了这个假设):
          // 无论这轮分析用的是全局默认后端/模型,还是 split 菜单临时选的
          // backendOverride,main 侧 finish()/deepenInner 的 upsertSlot 都会
          // 把"刚写完的那个槽"设成新的 lastSlotKey(见 analysis.ts run()
          // finish 与 deepenInner writeMerged 的注释)——也就是说"这轮刚完成
          // 的结果"和"新的激活槽"永远是同一个槽。产品行为按 spec 拍板是
          // 「新分析完成回到最新槽」,不区分是哪个模型跑的,所以这里恒定
          // owner="active",不用 d.slotKey 分叉判断。
          resultOwnerRef.current = "active";
          setResult(d.result as AnalysisResult);
          setState("done");
          setError("");
          // 新分析落地:回到「跟随 activeKey」,丢弃任何还在飞的旧槽 tab 请求
          // (否则那份迟到的 getCached 响应可能把刚出炉的新结果又盖回旧槽)。
          setSelectedSlotKey(null);
          slotRequestRef.current = null;
          // 槽摘要可能已变(新增槽/换了 activeKey/某槽因 PROMPT_VERSION 升级
          // 而变 stale)——重新拉一次 getState 让 tab 条与磁盘保持一致
          // (agy flash 复核 F2:此前 onDone 只更新 result,不刷新 tab 列表)。
          void bridge()
            .analysis.getState(matchId)
            .then(
              ({
                slots: s,
                activeKey: ak,
              }: {
                slots?: Array<{
                  key: string;
                  createdAt: number;
                  stale: boolean;
                }>;
                activeKey?: string | null;
              }) => {
                if (resultForRef.current !== matchId) return; // 切场竞态
                // 防御性核对(不改变展示):payload 的 slotKey 理论上必然等于
                // 刚刷新出的 activeKey——上面那条不变式如果哪天被违反(比如
                // main 侧漏改了某个写盘分支),这里能第一时间在控制台留痕,
                // 而不是让面板悄悄展示错的槽却无人知晓。仍然按 ak 走展示。
                if (d.slotKey && ak != null && d.slotKey !== ak) {
                  console.warn(
                    `[analysis] onDone slotKey(${d.slotKey}) != 刷新后 activeKey(${ak})—— 违反"完成槽即激活槽"不变式,仍按 activeKey 展示`,
                  );
                }
                setSlots(s ?? []);
                setActiveKey(ak ?? null);
              },
            )
            .catch(() => {});
        },
      );
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

  // #15 内联图标:每场/每语言构建一次;dataReady 翻真后重建(索引从 null
  // 变可用,展示路径自愈——ensure 契约)。
  const rich = useMemo(
    () => makeRichText(source, lang ?? "zh"),
    [source, lang, dataReady],
  );

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
    // 多模型槽(Task 3):自动深挖只对当前激活槽生效——查看旧槽/其他模型槽时
    // 不触发,避免把深挖结果写串槽。用 resultOwnerRef(与每次 setResult 同步
    // 写入)而非从 selectedSlotKey/activeKey 派生的 displayedSlotKey 判断:
    // 后者在切槽点击的瞬间就已翻新,但此刻 result 状态其实还没换成新槽内容
    // (getCached 还没 resolve),那样判会在这个中间态里把旧槽内容深挖进
    // 激活槽(agy flash 复核发现的竞态,已用 resultOwnerRef 消除)。
    if (resultOwnerRef.current !== "active") return;
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

  // tab 切换(Task 3):点非当前展示的槽 → 读该槽缓存并展示,不发 run/deepen。
  // 守卫双保险:matchId 归属(复用 resultForRef,与其余异步回填同款模式)+
  // slotRequestRef(丢弃被后一次点击抢先的迟到响应)。
  const handleSelectSlot = (key: string) => {
    if (key === displayedSlotKey) return;
    const forMatch = matchId;
    setSelectedSlotKey(key);
    slotRequestRef.current = key;
    void bridge()
      .analysis.getCached(matchId, key)
      .then((cached) => {
        if (resultForRef.current !== forMatch) return; // 切场竞态
        if (slotRequestRef.current !== key) return; // 被更新的一次点击抢先
        if (cached) {
          resultForRef.current = forMatch;
          // 用 activeKeyRef(而非闭包里捕获点击那一刻的 activeKey)判断刚
          // 取到手的这份内容是不是激活槽——await 期间 activeKey 状态可能
          // 已经被并发的 onDone 刷新过,ref 保证读到当下最新值。
          resultOwnerRef.current =
            key === activeKeyRef.current ? "active" : "other";
          setResult(cached as AnalysisResult);
          setState("done");
        }
      })
      .catch(() => {});
  };

  // split 按钮「选用其他模型分析」(Task 4)。
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // null = 尚未探测过;探测后是 backend→path 的映射(仅本地 CLI 三个后端)。
  const [cliDetected, setCliDetected] = useState<Partial<
    Record<AiBackend, string | null>
  > | null>(null);
  // 探测只在首次开菜单时并发发一轮、缓存到组件态(会话内不重复探测)。
  const cliProbeStartedRef = useRef(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const probeCliOnce = () => {
    if (cliProbeStartedRef.current) return;
    cliProbeStartedRef.current = true;
    const cliBackends = Object.keys(BACKEND_CLI_TOOL) as AiBackend[];
    void Promise.all(
      cliBackends.map(async (b) => {
        try {
          const r = await bridge().ai?.detectCli?.(b);
          return [b, r?.path ?? null] as const;
        } catch {
          return [b, null] as const; // 桩/环境无 ai 面:视为未检测到
        }
      }),
    ).then((pairs) => setCliDetected(Object.fromEntries(pairs)));
  };

  // Esc / 点击外部关闭菜单(a11y 基本盘)。
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        modelMenuRef.current &&
        !modelMenuRef.current.contains(e.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modelMenuOpen]);

  // 后端可用性:本地 CLI 三个按探测结果(未探测完成前视为不可用,菜单
  // 打开瞬间会因为 setCliDetected 异步回填而多渲一次,属预期);
  // anthropic/deepseek 按 settings 哨兵真值(brief 口径:truthy 即可,
  // 不需要跟 REDACTED 常量比较——真 key 与掩码串同样是非空字符串)。
  const isBackendAvailable = (b: AiBackend): boolean => {
    const cliTool = BACKEND_CLI_TOOL[b];
    if (cliTool) return !!cliDetected && cliDetected[b] != null;
    if (b === "anthropic") return !!aiSettings?.anthropicApiKey;
    if (b === "deepseek") return !!aiSettings?.deepseekApiKey;
    return false;
  };

  const defaultBackend: AiBackend = aiSettings?.aiBackend ?? "anthropic";
  const defaultModel = resolveAiModel({
    aiBackend: aiSettings?.aiBackend,
    aiModels: aiSettings?.aiModels,
  });

  const runAnalyze = async (backendOverride?: {
    backend: AiBackend;
    model: string;
  }) => {
    if (!input) return;
    setError("");
    setPreview("");
    setState("running");
    onRunAll?.(); // 一键同跑 cohort 对比
    await bridge().analysis.run(
      backendOverride ? { ...input, backendOverride } : input,
    );
  };

  // 两条入口都先关菜单再发起(agy flash 复核发现的并发口子):菜单开着时
  // 点主按钮跑默认分析,若不关菜单,菜单项按钮此时仍可点——用户能在默认
  // 分析已经进 running 后又点一个菜单项,main 侧 nextGen 会让后发的这次
  // 覆盖代际、腰斩刚发出去的第一次请求(白烧一次 token)。在这里同步关闭
  // (与 setState("running") 同一次事件循环内),不依赖"运行中禁用整个
  // split"的按钮 disabled 属性——那个只挡得住"再点箭头开新菜单",挡不住
  // "菜单已经开着、按钮还没重渲成 disabled 前的这一下"。
  const handleAnalyze = () => {
    setModelMenuOpen(false);
    void runAnalyze();
  };

  const handleSelectModel = (backend: AiBackend, model: string) => {
    setModelMenuOpen(false);
    void runAnalyze({ backend, model });
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
        <div className="rpt-ai-split" ref={modelMenuRef}>
          <button
            className="rpt-ai-primary"
            onClick={handleAnalyze}
            disabled={!input || state === "running"}
          >
            {buttonText}
          </button>
          <button
            className="rpt-ai-split-arrow"
            data-testid="analysis-model-picker"
            aria-label="选用其他模型分析"
            aria-haspopup="menu"
            aria-expanded={modelMenuOpen}
            // 只按运行态禁用(brief 口径:「运行中禁用整个 split」),不叠加
            // !input——浏览"有哪些模型可选"不需要 input 就绪,真正发起分析
            // 时 runAnalyze 内部仍会按 !input 短路(与主按钮同守卫,双保险)。
            disabled={state === "running"}
            onClick={() => {
              if (!modelMenuOpen) probeCliOnce();
              setModelMenuOpen((o) => !o);
            }}
          >
            ▾
          </button>
          {modelMenuOpen && (
            <div
              className="rpt-ai-model-menu"
              data-testid="analysis-model-menu"
              role="menu"
            >
              {AI_BACKENDS.filter(isBackendAvailable).map((b) => (
                <div key={b} className="rpt-ai-model-group" role="group">
                  {AI_MODELS[b].map((m) => {
                    const isDefault =
                      b === defaultBackend && m.id === defaultModel;
                    return (
                      <button
                        key={m.id}
                        role="menuitem"
                        onClick={() => handleSelectModel(b, m.id)}
                      >
                        {slotLabel(`${b}:${m.id}`)}
                        {isDefault ? " (默认)" : ""}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
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
          {/* 多模型槽 tab 条(Task 3):≥2 槽才出现,单模型用户零观感变化。 */}
          {slots.length >= 2 && (
            <div className="rpt-slot-tabs" data-testid="analysis-slot-tabs">
              {slots.map((slot) => (
                <button
                  key={slot.key}
                  className={slot.key === displayedSlotKey ? "active" : ""}
                  onClick={() => handleSelectSlot(slot.key)}
                >
                  {slotLabel(slot.key)}
                  {slot.stale && <span className="rpt-slot-stale">旧版</span>}
                </button>
              ))}
            </div>
          )}
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
                rich={rich}
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
                rich={rich}
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
                rich={rich}
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
                    rich={rich}
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
