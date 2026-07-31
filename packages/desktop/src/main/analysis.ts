import {
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { recordAiDebug } from "./aiDebugLog";
// 刻意绕开 @gladlog/analysis 的 barrel:index.ts 会把 spellNames(12MB)/
// talentIdMap(1.6MB)的顶层 await 拖进 main 的模块图 —— 顶层 await 使
// tree-shaking 失效,main 白付 13.6MB 读盘 + ~40MB 常驻堆。deepDive 是唯一
// 真依赖这两张表的入口(经 utils→spellEffectData/talents),所以它的值导入
// 挪进 deepenInner 按需 await import,这里只留 type。
import type {
  DeepDivePack,
  DeepDiveResult,
} from "@gladlog/analysis/src/analysis/deepDive";
import { findingKey } from "../shared/findingKey";
import { normalizeFindingCategory } from "@gladlog/analysis/src/analysis/findingCategories";
import { parseModelJsonArray } from "@gladlog/analysis/src/analysis/parseModelJson";
import { resolveAiModel, type AiModelSelection } from "../shared/aiModels";
import { join } from "path";
import { buildFindingsPrompt } from "@gladlog/analysis/src/analysis/buildFindingsPrompt";
import { auditFindings } from "@gladlog/analysis/src/analysis/auditFindings";
import type {
  CandidateEvent,
  Finding,
  RawFinding,
} from "@gladlog/analysis/src/analysis/types";
import { analysisCacheDoc, analysisCachePath } from "../shared/analysisCache";
import {
  buildCoachSystemPrompt,
  PROMPT_VERSION,
  resolveAiClient,
  type AiBackend,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";

export type AnalysisInput = {
  matchId: string;
  candidates: CandidateEvent[];
  richContext: string;
  spec: string;
};
export type AnalysisResult = {
  findings: Finding[];
  dropped: number;
  hadNarration: boolean;
  /** 确定性回退的原因(hadNarration=false 时);旧缓存无此字段。 */
  fallbackReason?: "no-candidates" | "no-client" | "bad-json";
  /** 深挖轮已跑(无论产出几条),renderer 防重触发。 */
  deepened?: boolean;
};
export type DeepenInput = {
  matchId: string;
  findings: Finding[];
  packs: DeepDivePack[];
  spec: string;
  ownerName?: string;
};
export type WindowAnalyzeInput = {
  matchId: string;
  fromS: number;
  toS: number;
  pack: DeepDivePack;
  kind: "survival" | "offensive";
  spec: string;
  ownerName?: string;
};
export type WindowAnalyzeResult =
  | {
      status: "ok";
      text: string;
      chips: DeepDiveResult["chips"];
      fromCache: boolean;
    }
  | { status: "audit-empty" } // 模型输出全部未过审计(或空)→ UI 提示可重试
  | { status: "no-client" } // 未配 AI → UI 提示去设置
  | { status: "busy" } // 同场同窗口在飞(幂等守卫)
  | { status: "error" }; // 网络/流式异常(与 audit-empty 拆开:后者是"模型答了但审不过",前者是"没答上")

/** 选段窗口分析缓存(#16)上限:超出按 at(写入时刻)驱逐最旧,防止长会话
 * 无界增长(单场可选任意多窗口)。 */
const WINDOW_CACHE_MAX = 20;

type WindowCacheEntry = {
  fromS: number;
  toS: number;
  text: string;
  chips: DeepDiveResult["chips"];
  at: number;
  /** Important 审计修复(#16 缺版本戳):stamped at write time so a later
   * PROMPT_VERSION bump doesn't let a stale entry serve forever. Stamped
   * per-entry (not per-file) because one windowAnalysis.<lang>.json holds
   * many independent windows — file-level stamping would nuke every entry
   * in the file on any bump instead of just letting the touched ones churn
   * naturally, which is needlessly destructive for a file that's already
   * an LRU of unrelated windows. */
  promptVersion: number;
};

export function createAnalysisService(deps: {
  getSettings: () => {
    anthropicApiKey: string | null;
    aiModels?: AiModelSelection | null;
    wowDirectory: string | null;
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiLanguage?: AiLanguage;
  };
  clientFactory?: (key: string) => AnthropicLike;
  matchesDir: string;
  emit: (channel: string, payload: unknown) => void;
  /** 学习台账写入点(spec §1):模型真跑过或干净场(no-candidates)时回调;
   * no-client/bad-json 不算已分析。失败由接收方消化,这里 fire-and-forget。 */
  onFindings?: (e: {
    matchId: string;
    findings: Finding[];
    candidates: CandidateEvent[];
  }) => void;
}) {
  // 代际计数器按 matchId 分桶:每场独立。旧实现是单个全局计数器,任何新
  // run/deepen(比如开 B 场或深挖 B)都会 ++,让 A 场正在跑的分析被判过期 abort、
  // 永不写缓存 —— 这正是「看别的游戏就丢了之前的分析」的根。
  const generations = new Map<string, number>();
  const nextGen = (matchId: string) => {
    const g = (generations.get(matchId) ?? 0) + 1;
    generations.set(matchId, g);
    return g;
  };
  const isCurrent = (matchId: string, gen: number) =>
    generations.get(matchId) === gen;

  // 当前正在跑首轮分析的 matchId → 拥有它的 run 代际。渲染层重挂(切 tab/切场
  // 回来)时查询,若在跑就显示「分析中…」而非空闲态,省得用户以为丢了又点一次。
  // 存代际而非裸集合:清理时按「我是不是这条 running 的主人」判,而不是按代际是否
  // 最新 —— 否则 deepen 会 ++ 代际、让被它取代的 run abort 时判自己非最新而不清,
  // running 永久残留(复审发现:换语言到无缓存的语言会卡在分析中)。
  const running = new Map<string, number>();

  /** 正在深挖的 matchId —— 幂等守卫用,见 deepen。 */
  const deepening = new Set<string>();

  /** 正在飞的选段窗口分析(#16),键 = `${matchId}:${windowKey}`。窗口分析
   * 是单请求-响应、不与 run/deepen 抢写 analysis-v2 缓存,故不需要代际计数器
   * ——幂等守卫单靠这个 Set 即可,同场同窗口重复触发直接判 busy。 */
  const windowInFlight = new Set<string>();

  /**
   * 回收该场的代际条目。generations 只增不删的话,长会话里每个看过的 matchId
   * 都会留一条(量很小,但没有理由留)。
   *
   * 只在该场彻底静默(无 run、无 deepen 在飞)时回收 —— 否则在飞的那一轮
   * 会因为 generations.get() 变 undefined 而 isCurrent 判假,把自己当成过期的
   * 中途 abort,等于凭空丢一次分析。
   */
  const reapGeneration = (matchId: string) => {
    if (!running.has(matchId) && !deepening.has(matchId))
      generations.delete(matchId);
  };

  async function run(input: AnalysisInput): Promise<void> {
    const myGen = nextGen(input.matchId);
    running.set(input.matchId, myGen);
    const clearRunning = () => {
      // 仅当这条 running 仍归我(未被更晚的 run 接管)才清。deepen 不碰 running,
      // 故被 deepen 取代的 run 走到这里 running 仍是自己 → 正常清,不泄漏。
      if (running.get(input.matchId) === myGen) running.delete(input.matchId);
      reapGeneration(input.matchId);
    };
    const settings = deps.getSettings();
    const lang: AiLanguage = settings.aiLanguage ?? "zh";

    const finish = (result: AnalysisResult, record = false) => {
      clearRunning();
      const dir = join(deps.matchesDir, input.matchId);
      try {
        mkdirSync(dir, { recursive: true });
        // 语言分键缓存(backlog #1 推荐项):两种语言的结果可同时保留
        // 已知设计缺口(Important 审计,今天不动):键只按 matchId+lang,不含
        // backend/model —— 切后端重跑同场会静默复用旧后端的缓存结果。
        // analyzeWindow 的选段缓存已修(键含 `${backend}:${model}`),这里
        // 同理但范围更大(涉及 listAnalyzed/aggregate/notebook 等下游读者),
        // 留到专项处理,不在本次 #16 窗口缓存修复里顺手带上。
        const target = analysisCachePath(deps.matchesDir, input.matchId, lang);
        const tmp = `${target}.tmp`;
        writeFileSync(
          tmp,
          JSON.stringify(analysisCacheDoc(lang, result)),
          "utf-8",
        );
        renameSync(tmp, target);
      } catch {
        /* best-effort */
      }
      deps.emit("gladlog:analysis:done", { matchId: input.matchId, result });
      if (record) {
        try {
          deps.onFindings?.({
            matchId: input.matchId,
            findings: result.findings,
            candidates: input.candidates,
          });
        } catch {
          /* 台账写失败不影响分析主流程 */
        }
      }
    };

    // deterministic fallback: no narration;reason 让 UI 分因显示(0 finding 可解释)
    const fallback = (reason: "no-candidates" | "no-client" | "bad-json") =>
      finish(
        {
          findings: [],
          dropped: 0,
          hadNarration: false,
          fallbackReason: reason,
        },
        reason === "no-candidates",
      );

    if (input.candidates.length === 0) return fallback("no-candidates");
    const client = resolveAiClient(settings, deps.clientFactory);
    if (!client) return fallback("no-client");

    try {
      const prompt = buildFindingsPrompt(
        input.candidates,
        input.richContext,
        input.spec,
      );
      // 单次调用 + 解析;attempt 标注进 debug 面板便于区分重试
      const callOnce = async (attempt: number) => {
        let raw = "";
        const stream = client.stream({
          model: resolveAiModel(settings),
          // 4-8 条 findings(2026-07-24 扩量)+ 中文解释;4096 按 3-5 条定,
          // 生产撞过截断→bad-json 整体回退。
          max_tokens: 8192,
          system: buildCoachSystemPrompt(lang),
          messages: [{ role: "user", content: prompt }],
        });
        for await (const ev of stream) {
          if (!isCurrent(input.matchId, myGen)) return null;
          if (ev.delta) {
            raw += ev.delta;
            // 重试轮不发 delta:renderer 预览流是纯追加,attempt 1 的残骸
            // 拼上 attempt 2 会显示成乱码(agy 复核 F4)。
            if (attempt === 1)
              deps.emit("gladlog:analysis:delta", {
                matchId: input.matchId,
                text: ev.delta,
              });
          }
        }
        if (!isCurrent(input.matchId, myGen)) return null;
        recordAiDebug({
          kind: "analysis",
          matchId: attempt > 1 ? `${input.matchId}#retry` : input.matchId,
          at: Date.now(),
          model: resolveAiModel(settings),
          prompt,
          raw,
        });
        // 围栏/散文容错走共享谓词(parseModelJson):claude -p 实测会把完全
        // 合规的内容包进 ```json 围栏,旧的 JSON.parse(raw.trim()) 零容错,
        // 整份好分析被误判 bad-json。截断与顶层对象仍返回 null → 按契约失败。
        return { parsed: parseModelJsonArray(raw) as RawFinding[] | null };
      };

      let call = await callOnce(1);
      if (call === null) {
        clearRunning();
        return;
      }
      // bad-json 单次重试:模型输出是随机的,一次失败 ≠ 稳定失败;生产反馈
      // 「格式异常」多为偶发,重试把失败率砍半量级,契约(截断/顶层对象不救)不变。
      if (!call.parsed) {
        call = await callOnce(2);
        if (call === null) {
          clearRunning();
          return;
        }
      }
      const parsed = call.parsed;
      if (!parsed) {
        return fallback("bad-json"); // invalid JSON → deterministic
      }
      const audit = auditFindings(parsed, input.candidates);
      finish(
        {
          findings: audit.findings,
          dropped: audit.dropped.length,
          hadNarration: audit.findings.length > 0,
        },
        true,
      );
    } catch (err) {
      if (!isCurrent(input.matchId, myGen)) return;
      clearRunning();
      deps.emit("gladlog:analysis:error", {
        matchId: input.matchId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const flagsPath = (matchId: string) =>
    join(deps.matchesDir, matchId, "findingFlags.json");

  /**
   * 深挖轮(自动追问):renderer 在初轮 done 后为高严重度 finding 构建
   * 确定性证据包并调用;本方法跑第二次 LLM、auditDeepDives 审计、把
   * deepDive 合并进缓存与结果,再 emit 一次 done。审不过 → 静默保持初轮。
   *
   * 幂等守卫:同一场深挖在飞时,重复调用直接丢弃。renderer 的触发条件是
   * 缓存里 `deepened` 仍为 false,而该标志要等本轮 writeMerged 才落盘 ——
   * 深挖在飞的那几十秒里用户切走再切回,面板重挂就会再触发一次,白烧一轮
   * token(旧 gen 虽会被 nextGen 判过期 abort,但请求早已发出、钱已经花了)。
   * 守卫必须放主进程:renderer 侧「先查 isDeepening 再调」是 TOCTOU,两次
   * 重挂可能都查到 false,挡不住。
   */
  async function deepen(input: DeepenInput): Promise<void> {
    if (deepening.has(input.matchId)) return;
    deepening.add(input.matchId);
    try {
      await deepenInner(input);
    } finally {
      deepening.delete(input.matchId);
      reapGeneration(input.matchId);
    }
  }

  async function deepenInner(input: DeepenInput): Promise<void> {
    const myGen = nextGen(input.matchId);
    const settings = deps.getSettings();
    const lang: AiLanguage = settings.aiLanguage ?? "zh";
    const client = resolveAiClient(settings, deps.clientFactory);
    // 无 client / 无 pack:标记 deepened 防重触发,内容保持初轮
    const cachedPath = join(
      deps.matchesDir,
      input.matchId,
      `analysis-v2.${lang}.json`,
    );
    const writeMerged = (findings: Finding[]) => {
      try {
        const doc = JSON.parse(readFileSync(cachedPath, "utf-8"));
        doc.result = { ...doc.result, findings, deepened: true };
        const tmp = cachedPath + ".tmp";
        writeFileSync(tmp, JSON.stringify(doc), "utf-8");
        renameSync(tmp, cachedPath);
        deps.emit("gladlog:analysis:done", {
          matchId: input.matchId,
          result: doc.result,
        });
      } catch {
        /* 缓存缺失:仅 emit 内存结果 */
        deps.emit("gladlog:analysis:done", {
          matchId: input.matchId,
          result: { findings, dropped: 0, hadNarration: true, deepened: true },
        });
      }
    };
    if (!client || input.packs.length === 0) return writeMerged(input.findings);
    try {
      // 按需加载:deepDive 连同 spellNames/talentIdMap 两张大表,静态
      // import 会让 main 启动就付 13.6MB;深挖是用户触发的 LLM 流程,首次
      // 多 ~50ms 无感。表已改后台加载(非 TLA),import resolve 不再保证
      // 表就绪 —— 提示词法术名不许降级,必须显式 await ensure(契约见
      // analysis 的 data/ensure.ts)。ensure 也走动态 import:它静态引数据
      // 模块,静态 import 会把「模块求值即踢加载」重新带回 main 启动路径。
      const [{ buildDeepDivePrompt, auditDeepDives }, { ensureAnalysisData }] =
        await Promise.all([
          import("@gladlog/analysis/src/analysis/deepDive"),
          import("@gladlog/analysis/src/data/ensure"),
        ]);
      await ensureAnalysisData();
      const prompt = buildDeepDivePrompt(
        input.packs,
        input.findings,
        input.spec,
        input.ownerName,
      );
      let raw = "";
      const stream = client.stream({
        model: resolveAiModel(settings),
        // 深挖输出随 findings 条数走(2026-07-24 后可到 8 条 × 文本+chips),
        // 2048 按 ~3 条定,必截断 → 深挖静默消失。
        max_tokens: 4096,
        system: buildCoachSystemPrompt(lang),
        messages: [{ role: "user", content: prompt }],
      });
      for await (const ev of stream) {
        if (!isCurrent(input.matchId, myGen)) return;
        if (ev.delta) raw += ev.delta;
      }
      if (!isCurrent(input.matchId, myGen)) return;
      recordAiDebug({
        kind: "analysis",
        matchId: `${input.matchId}#deepdive`,
        at: Date.now(),
        model: resolveAiModel(settings),
        prompt,
        raw,
      });
      // 同 findings 路径:围栏包裹时旧写法拿不到数组,深挖会静默消失
      // (auditDeepDives 内部 Array.isArray 判假直接返回空)。null → 保持初轮。
      const parsed = parseModelJsonArray(raw);
      const dives = auditDeepDives(parsed, input.packs);
      const merged = input.findings.map((f, i) => {
        const d = dives.find((x) => x.findingIndex === i);
        return d ? { ...f, deepDive: { text: d.text, chips: d.chips } } : f;
      });
      if (!isCurrent(input.matchId, myGen)) return; // 保险:写盘/emit 前复查代际
      writeMerged(merged);
    } catch {
      if (!isCurrent(input.matchId, myGen)) return;
      writeMerged(input.findings); // 深挖失败不致命,保持初轮
    }
  }

  const windowCachePath = (matchId: string, lang: AiLanguage) =>
    join(deps.matchesDir, matchId, `windowAnalysis.${lang}.json`);

  /**
   * 选段窗口分析(#16 Task 3):用户在回放上手动拖窗口,单窗口单次请求-响应
   * (不像 run/deepen 是全场轮次,故不参与代际计数器,也不与 analysis-v2
   * 缓存互相作废)。落盘缓存按 matchId+lang 分文件、按 windowKey 分条目,
   * 超过 WINDOW_CACHE_MAX 按写入时刻(at)驱逐最旧。
   */
  async function analyzeWindow(
    input: WindowAnalyzeInput,
  ): Promise<WindowAnalyzeResult> {
    // 取一次 settings,贯穿整个函数(缓存键、client 解析、model 解析都用
    // 同一份)——键必须与实际调用 client.stream 时用的 backend/model 同源,
    // 否则「键里写一套、真跑另一套」这条谓词又会悄悄裂开。
    const settings = deps.getSettings();
    const lang: AiLanguage = settings.aiLanguage ?? "zh";
    // Important 审计修复(#16 三条之二):后端+模型纳入缓存键。原键只有
    // fromS-toS,切后端/模型后重跑同一窗口会静默拿到旧后端的答案。判据
    // 与 run() 调用 client.stream 时的 resolveAiModel(settings) 同一函数
    // (谓词单源),backend 的默认值也镜像 resolveAiModel 内部 `?? "anthropic"`。
    // 主 analysis-v2 缓存(run/deepen)有同样的设计缺口,但今天不动它——
    // 见 finish() 里的一行注释。
    const backend: AiBackend = settings.aiBackend ?? "anthropic";
    const model = resolveAiModel(settings);
    // Important 审计修复(#16 三条之三):键精度从整秒 floor 改到 0.1s round,
    // 与 Timeline 拖拽精度对齐——floor 到整秒会把明显不同的两次拖拽(如
    // 30.2s-60.0s 与 30.8s-60.0s)塞进同一条目,互相顶掉。
    const round1 = (s: number) => Math.round(s * 10) / 10;
    const windowKey = `${backend}:${model}:${round1(input.fromS)}-${round1(input.toS)}`;
    const flight = `${input.matchId}:${windowKey}`;
    if (windowInFlight.has(flight)) return { status: "busy" };
    windowInFlight.add(flight);
    // catch 分支要落 debug 记录(prompt/raw),但 prompt 要到 buildDeepDivePrompt
    // 才赋值——动态 import/ensureAnalysisData 之前炸的话它仍是 undefined,
    // 声明在 try 外并置空串兜底,别让 catch 里访问未初始化变量。
    let prompt = "";
    try {
      const path = windowCachePath(input.matchId, lang);
      let cache: Record<string, WindowCacheEntry> = {};
      try {
        cache = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        /* 首次 */
      }
      const hit = cache[windowKey];
      // Important 审计修复(#16 三条之一):版本戳校验 —— prompt 生成变了
      // (PROMPT_VERSION bump)老条目必须判 miss 重算,而不是无限期把旧版本
      // 答案当命中返回。旧缓存(升级前写入,无此字段)undefined !== 数字
      // 天然判 miss,不需要额外迁移逻辑。
      if (hit && hit.promptVersion === PROMPT_VERSION)
        return {
          status: "ok",
          text: hit.text,
          chips: hit.chips,
          fromCache: true,
        };

      const client = resolveAiClient(settings, deps.clientFactory);
      if (!client) return { status: "no-client" };

      // 动态 import:与 deepenInner 同理由(13.6MB 表不进 main 启动模块图)
      const [
        { buildDeepDivePrompt, auditDeepDives, buildWindowAnchorFinding },
        { ensureAnalysisData },
      ] = await Promise.all([
        import("@gladlog/analysis/src/analysis/deepDive"),
        import("@gladlog/analysis/src/data/ensure"),
      ]);
      await ensureAnalysisData();
      const anchor = buildWindowAnchorFinding(
        input.pack,
        input.fromS,
        input.toS,
        input.kind,
      );
      prompt = buildDeepDivePrompt(
        [input.pack],
        [anchor],
        input.spec,
        input.ownerName,
        "window",
      );
      let raw = "";
      const stream = client.stream({
        model: resolveAiModel(settings),
        max_tokens: 2048, // 单 pack 单段,deepen 的 4096 是 8 条口径
        system: buildCoachSystemPrompt(lang),
        messages: [{ role: "user", content: prompt }],
      });
      for await (const ev of stream) if (ev.delta) raw += ev.delta;
      recordAiDebug({
        kind: "analysis",
        matchId: `${input.matchId}#window:${windowKey}`,
        at: Date.now(),
        model: resolveAiModel(settings),
        prompt,
        raw,
      });
      const dives = auditDeepDives(parseModelJsonArray(raw), [input.pack]);
      const d = dives.find((x) => x.findingIndex === 0);
      if (!d) return { status: "audit-empty" }; // 不落盘,允许重试

      // 跨窗口 lost-update 修复:幂等守卫按 `${matchId}:${windowKey}` 只
      // 序列化同一窗口的并发,同场不同窗口仍可并发跑到这里;函数头那次
      // readFileSync 只用于 cache-hit 判断,不能再当写回基底 —— 否则两边
      // 各拿着同一份旧快照,晚写的那个整份 stringify 覆盖会把早写的条目
      // 静默抹掉。写盘前必须重新读一次最新文件、在最新快照上 upsert 自己
      // 这条 key,再做 LRU 驱逐与 tmp+rename。
      let latest: Record<string, WindowCacheEntry> = {};
      try {
        latest = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        /* 首次或已被清空 */
      }
      latest[windowKey] = {
        fromS: input.fromS,
        toS: input.toS,
        text: d.text,
        chips: d.chips,
        at: Date.now(),
        promptVersion: PROMPT_VERSION,
      };
      const keys = Object.keys(latest);
      if (keys.length > WINDOW_CACHE_MAX) {
        const evict = keys
          .sort((a, b) => latest[a]!.at - latest[b]!.at)
          .slice(0, keys.length - WINDOW_CACHE_MAX);
        for (const k of evict) delete latest[k];
      }
      mkdirSync(join(deps.matchesDir, input.matchId), { recursive: true });
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(latest), "utf-8");
      renameSync(tmp, path);
      return { status: "ok", text: d.text, chips: d.chips, fromCache: false };
    } catch (err) {
      // Important 修复:catch-all 原先静默吞异常,stream 中途炸时连
      // prompt/raw 都不留,真机 smoke 遇失败无从定位。落一条 error 记录
      // (windowKey 加 #error 后缀,与正常成功记录分开);debug 记录本身
      // 不许再抛 —— 包一层 try/catch,记录失败也不影响主流程返回。
      try {
        recordAiDebug({
          kind: "analysis",
          matchId: `${input.matchId}#window:${windowKey}#error`,
          at: Date.now(),
          model: resolveAiModel(deps.getSettings()),
          prompt,
          raw: String(err),
        });
      } catch {
        /* debug 记录失败不影响主流程 */
      }
      return { status: "error" }; // 网络/流式异常:可重试,不落盘(与
      // audit-empty 区分:那是"模型答了但审不过",这是"没答上")
    } finally {
      windowInFlight.delete(flight);
    }
  }

  return {
    run,
    deepen,
    analyzeWindow,
    async cancel(matchId?: string): Promise<void> {
      // 定点取消(批量用):只作废该场在飞的 run/deepen —— 全局版会把用户
      // 手动在跑的别场分析一并 abort(agy flash 复核 F1)。
      if (matchId !== undefined) {
        const g = generations.get(matchId);
        if (g !== undefined) generations.set(matchId, g + 1);
        running.delete(matchId);
        return;
      }
      // 全场取消:每场代际 +1,所有在跑的 run/deepen 循环下一拍即 abort。
      for (const [id, g] of generations) generations.set(id, g + 1);
      running.clear();
    },
    /** 首轮分析是否正在跑(渲染层重挂时查询,显示「分析中…」防重点)。 */
    async isRunning(matchId: string): Promise<boolean> {
      return running.has(matchId);
    },
    /** finding 跟进标记(phase3 #3a)。key = category|sorted(eventIds),语言无关。 */
    async getFlags(matchId: string): Promise<Record<string, string>> {
      try {
        return JSON.parse(readFileSync(flagsPath(matchId), "utf-8"));
      } catch {
        return {};
      }
    },
    /**
     * 跨场聚合(phase3 #3b):扫全部已分析对局的 findings,按 category 计数
     * (双语言缓存按 lang 优先取一份,不重复计),附最近实例与标记统计。
     */
    async aggregate(): Promise<
      Array<{
        category: string;
        count: number;
        recurring: number;
        done: number;
        recent: Array<{
          matchId: string;
          title: string;
          severity: string;
          createdAt: number;
        }>;
      }>
    > {
      const lang: AiLanguage = deps.getSettings().aiLanguage ?? "zh";
      let dirs: string[] = [];
      try {
        dirs = readdirSync(deps.matchesDir).filter(
          (d) => !d.startsWith(".") && !d.startsWith("_"),
        );
      } catch {
        return [];
      }
      const byCategory = new Map<
        string,
        {
          count: number;
          recurring: number;
          done: number;
          recent: Array<{
            matchId: string;
            title: string;
            severity: string;
            createdAt: number;
          }>;
        }
      >();
      for (const dir of dirs) {
        const base = join(deps.matchesDir, dir);
        const candidates = [
          `analysis-v2.${lang}.json`,
          `analysis-v2.${lang === "zh" ? "en" : "zh"}.json`,
          "analysis-v2.json",
        ];
        const file = candidates.find((f) => existsSync(join(base, f)));
        if (!file) continue;
        try {
          const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
          if (doc.promptVersion !== PROMPT_VERSION) continue;
          const findings: Array<{
            category: string;
            title: string;
            severity: string;
            eventIds?: string[];
          }> = doc.result?.findings ?? [];
          let flags: Record<string, string> = {};
          try {
            flags = JSON.parse(
              readFileSync(join(base, "findingFlags.json"), "utf-8"),
            );
          } catch {
            /* 无标记 */
          }
          let matchId = dir;
          try {
            matchId = JSON.parse(
              readFileSync(join(base, "..", dir, "meta.json"), "utf-8"),
            ).id;
          } catch {
            /* 目录名兜底 */
          }
          for (const f of findings) {
            // 聚合键走归一(枚举化前的历史缓存 SURVIVAL/目标选择 等并进
            // 同一 slug 组);flags 仍按存档原样的 findingKey 查,不迁移
            const cat = normalizeFindingCategory(f.category);
            const agg = byCategory.get(cat) ?? {
              count: 0,
              recurring: 0,
              done: 0,
              recent: [],
            };
            agg.count++;
            const flag = flags[findingKey(f)];
            if (flag === "recurring") agg.recurring++;
            if (flag === "done") agg.done++;
            agg.recent.push({
              matchId,
              title: f.title,
              severity: f.severity,
              createdAt: doc.createdAt ?? 0,
            });
            byCategory.set(cat, agg);
          }
        } catch {
          /* 坏文件跳过 */
        }
      }
      return [...byCategory.entries()]
        .map(([category, a]) => ({
          category,
          count: a.count,
          recurring: a.recurring,
          done: a.done,
          recent: a.recent
            .sort((x, y) => y.createdAt - x.createdAt)
            .slice(0, 3),
        }))
        .sort((a, b) => b.count - a.count);
    },
    /**
     * 错题本(跨场):全部已分析对局的 findings 按 category 分组,
     * 每条带对局 meta(时间/地图/胜负)与跟进标记,组内按时间倒序。
     */
    async notebook(): Promise<
      Array<{
        category: string;
        count: number;
        recurring: number;
        done: number;
        entries: Array<{
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
        }>;
      }>
    > {
      const lang: AiLanguage = deps.getSettings().aiLanguage ?? "zh";
      let dirs: string[] = [];
      try {
        dirs = readdirSync(deps.matchesDir).filter(
          (d) => !d.startsWith(".") && !d.startsWith("_"),
        );
      } catch {
        return [];
      }
      type Entry = {
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
      };
      const byCategory = new Map<string, Entry[]>();
      for (const dir of dirs) {
        const base = join(deps.matchesDir, dir);
        const candidates = [
          `analysis-v2.${lang}.json`,
          `analysis-v2.${lang === "zh" ? "en" : "zh"}.json`,
          "analysis-v2.json",
        ];
        const file = candidates.find((f) => existsSync(join(base, f)));
        if (!file) continue;
        try {
          const doc = JSON.parse(readFileSync(join(base, file), "utf-8"));
          if (doc.promptVersion !== PROMPT_VERSION) continue;
          const findings: Array<{
            category: string;
            title: string;
            explanation?: string;
            severity: string;
            eventIds?: string[];
          }> = doc.result?.findings ?? [];
          if (findings.length === 0) continue;
          let flags: Record<string, string> = {};
          try {
            flags = JSON.parse(
              readFileSync(join(base, "findingFlags.json"), "utf-8"),
            );
          } catch {
            /* 无标记 */
          }
          let meta: {
            id?: string;
            startTime?: number;
            zoneId?: string;
            result?: string;
            bracket?: string;
          } = {};
          try {
            meta = JSON.parse(readFileSync(join(base, "meta.json"), "utf-8"));
          } catch {
            /* 目录名兜底 */
          }
          for (const f of findings) {
            const key = findingKey(f);
            const list = byCategory.get(f.category) ?? [];
            list.push({
              matchId: meta.id ?? dir,
              flagKey: key,
              flag: flags[key] ?? null,
              title: f.title,
              explanation: f.explanation ?? "",
              severity: f.severity,
              startTime: meta.startTime ?? doc.createdAt ?? 0,
              zoneId: meta.zoneId,
              result: meta.result,
              bracket: meta.bracket,
            });
            byCategory.set(f.category, list);
          }
        } catch {
          /* 坏文件跳过 */
        }
      }
      return [...byCategory.entries()]
        .map(([category, entries]) => ({
          category,
          count: entries.length,
          recurring: entries.filter((e) => e.flag === "recurring").length,
          done: entries.filter((e) => e.flag === "done").length,
          entries: entries.sort((a, b) => b.startTime - a.startTime),
        }))
        .sort((a, b) => b.count - a.count);
    },
    async setFlag(
      matchId: string,
      key: string,
      flag: "done" | "recurring" | null,
    ): Promise<Record<string, string>> {
      const cur = await this.getFlags(matchId);
      if (flag === null) delete cur[key];
      else cur[key] = flag;
      try {
        mkdirSync(join(deps.matchesDir, matchId), { recursive: true });
        const tmp = flagsPath(matchId) + ".tmp";
        writeFileSync(tmp, JSON.stringify(cur, null, 2), "utf-8");
        renameSync(tmp, flagsPath(matchId));
      } catch {
        /* best-effort */
      }
      return cur;
    },
    /**
     * 面板重挂时的**单次原子**查询(周度复核 P2#5)。
     *
     * 分两次 IPC(getCached → isRunning)时,两次 await 之间恰好完成的那一轮会
     * 掉进缝里:第一次读缓存还没落盘 → null,第二次查 running 已经清了 → false,
     * 面板于是停在空闲态,而结果其实已经躺在盘上(用户看到的还是「点我分析」)。
     *
     * 合并成一次调用后,renderer 侧不再有可插入的 await。顺序也刻意先 running
     * 后 cached:万一将来这里插入异步,后读的 cached 仍能兜住刚完成的那一轮;
     * 反过来写就还是漏。
     */
    /**
     * 仅测试用:代际表条目数。回收(reapGeneration)是纯内部状态,没有别的
     * 观察面 —— 泄漏只表现为内存缓慢增长,不暴露就只能靠读代码保证。
     */
    __generationCount(): number {
      return generations.size;
    },
    /**
     * 批量分析用:一次扫盘返回已有有效缓存(当前语言 + PROMPT_VERSION)的
     * 对局 id。命中谓词必须与 getCached 完全一致(谓词单源)—— 这里逐目录
     * 调 getCached,不另写一份文件名/版本判断。id 取 meta.json 的 id、
     * 目录名兜底(shuffle 非首回合的缓存目录无 meta,目录名即 round id)。
     */
    async listAnalyzed(): Promise<string[]> {
      let dirs: string[] = [];
      try {
        dirs = readdirSync(deps.matchesDir).filter(
          (d) => !d.startsWith(".") && !d.startsWith("_"),
        );
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const dir of dirs) {
        if (!(await this.getCached(dir))) continue;
        let id = dir;
        try {
          id =
            JSON.parse(
              readFileSync(join(deps.matchesDir, dir, "meta.json"), "utf-8"),
            ).id ?? dir;
        } catch {
          /* 无 meta:目录名兜底 */
        }
        out.push(id);
      }
      return out;
    },
    async getState(
      matchId: string,
    ): Promise<{ cached: AnalysisResult | null; running: boolean }> {
      const runningNow = running.has(matchId);
      const cached = await this.getCached(matchId);
      return { cached, running: runningNow };
    },
    async getCached(matchId: string): Promise<AnalysisResult | null> {
      const lang: AiLanguage = deps.getSettings().aiLanguage ?? "zh";
      let fp = analysisCachePath(deps.matchesDir, matchId, lang);
      if (!existsSync(fp)) {
        // 兼容:语言分键前的旧缓存没有 system prompt,输出实际是英文 ——
        // 只在请求英文时兜底读取,请求中文时视为未命中(重新生成)。
        const legacy = join(deps.matchesDir, matchId, "analysis-v2.json");
        if (lang !== "en" || !existsSync(legacy)) return null;
        fp = legacy;
      }
      try {
        const doc = JSON.parse(readFileSync(fp, "utf-8"));
        if (doc.promptVersion !== PROMPT_VERSION) return null;
        return doc.result as AnalysisResult;
      } catch {
        return null;
      }
    },
  };
}
export type AnalysisService = ReturnType<typeof createAnalysisService>;
