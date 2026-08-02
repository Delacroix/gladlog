import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import {
  analysisCachePath,
  splitSlotKey,
  toSlottedDoc,
} from "../shared/analysisCache";
import { PROMPT_VERSION } from "../shared/promptVersion";
import {
  resolveAiModel,
  type AiBackend,
  type AiModelSelection,
} from "../shared/aiModels";
import {
  buildCoachSystemPrompt,
  type AiLanguage,
  type AnthropicLike,
} from "./ai";
import {
  agyClientFactory,
  claudeCliClientFactory,
  codexClientFactory,
  continueCliChat,
  type CliChatBackend,
} from "./localAiBackends";
import type { AnalysisResult } from "./analysis";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: number;
};
export type ChatState =
  | { status: "unsupported" } // 当前后端非 CLI
  | { status: "not-ready" } // 该 CLI 无带 sessionId 的本回合分析,也无既有线程
  | {
      status: "ready";
      backend: string;
      model: string;
      messages: ChatMessage[];
      busy: boolean;
    };
export type ChatSendResult =
  | { status: "ok"; reply: string }
  | { status: "need-reseed" } // resume 失败且本次未带 seed:renderer 构建 seed 后重调
  | { status: "busy" | "unsupported" | "not-ready" }
  | { status: "error"; message: string };
export type ChatSeed = {
  richContext: string;
  spec: string;
  ownerName?: string;
  findingsSummary: string;
};

const CLI_BACKENDS: readonly string[] = ["claudeCli", "agy", "codex"];
/** 重发型种子/历史拼接的消息上限(spec:更早的截断并注明)。 */
const SEED_HISTORY_MAX = 30;

const chatPath = (matchesDir: string, matchId: string, lang: string) =>
  join(matchesDir, matchId, `coachChat.${lang}.json`);

type ChatThread = {
  sessionId: string;
  model: string;
  messages: ChatMessage[];
};
type ChatDoc = { version: 1; threads: Record<string, ChatThread> };

function readDoc(p: string): ChatDoc {
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (raw?.version === 1 && raw.threads) return raw as ChatDoc;
  } catch {
    /* 首次 */
  }
  return { version: 1, threads: {} };
}

function writeDoc(
  matchesDir: string,
  matchId: string,
  p: string,
  doc: ChatDoc,
) {
  mkdirSync(join(matchesDir, matchId), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc), "utf-8");
  renameSync(tmp, p);
}

/** 该 CLI 后端最新一个带 sessionId 且版本现行的分析槽。 */
function findAnalysisSession(
  matchesDir: string,
  matchId: string,
  lang: AiLanguage,
  backend: string,
): { sessionId: string; model: string } | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(
      readFileSync(analysisCachePath(matchesDir, matchId, lang), "utf-8"),
    );
  } catch {
    return null;
  }
  const doc = toSlottedDoc<AnalysisResult>(raw, "legacy:unknown");
  if (!doc) return null;
  let best: { sessionId: string; model: string; createdAt: number } | null =
    null;
  for (const [key, slot] of Object.entries(doc.slots)) {
    const split = splitSlotKey(key);
    if (!split || split.backend !== backend) continue;
    if (slot.promptVersion !== PROMPT_VERSION) continue;
    const sid = slot.result?.sessionId;
    if (!sid) continue;
    if (!best || slot.createdAt > best.createdAt)
      best = { sessionId: sid, model: split.model, createdAt: slot.createdAt };
  }
  return best ? { sessionId: best.sessionId, model: best.model } : null;
}

export function createCoachChatService(deps: {
  getSettings: () => {
    aiBackend?: AiBackend;
    aiBackendCommand?: string | null;
    aiModels?: AiModelSelection | null;
    aiLanguage?: AiLanguage;
  };
  matchesDir: string;
  /** 测试注入;生产走 localAiBackends 实函数。 */
  chatRunner?: typeof continueCliChat;
  seedClient?: (backend: CliChatBackend, cmd?: string) => AnthropicLike;
}): {
  getState(matchId: string): Promise<ChatState>;
  send(input: {
    matchId: string;
    question: string;
    seed?: ChatSeed;
  }): Promise<ChatSendResult>;
  cancel(matchId: string): Promise<void>;
} {
  const inFlight = new Map<string, AbortController>();
  const factories: Record<
    CliChatBackend,
    (o: { cmd?: string }) => AnthropicLike
  > = {
    claudeCli: claudeCliClientFactory,
    agy: agyClientFactory,
    codex: codexClientFactory,
  };
  const seedClient =
    deps.seedClient ??
    ((backend: CliChatBackend, cmd?: string) => factories[backend]({ cmd }));
  const chatRunner = deps.chatRunner ?? continueCliChat;

  const ctx = () => {
    const s = deps.getSettings();
    const backend = (s.aiBackend ?? "anthropic") as string;
    return {
      s,
      backend,
      lang: (s.aiLanguage ?? "zh") as AiLanguage,
      cmd: s.aiBackendCommand || undefined,
      isCli: CLI_BACKENDS.includes(backend),
    };
  };

  async function seedNewSession(p: {
    backend: CliChatBackend;
    cmd?: string;
    lang: AiLanguage;
    model: string;
    seed: ChatSeed;
    history: ChatMessage[];
    question: string;
    signal: AbortSignal;
  }): Promise<{ sessionId: string; reply: string }> {
    const hist = p.history.slice(-SEED_HISTORY_MAX);
    const histText = hist
      .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${m.content}`)
      .join("\n");
    const prompt = [
      `You previously analyzed this ${p.seed.spec} match and produced these findings:`,
      p.seed.findingsSummary,
      ``,
      `Full match context:`,
      p.seed.richContext,
      ``,
      ...(histText
        ? [
            p.history.length > SEED_HISTORY_MAX
              ? `Earlier conversation (older turns omitted):`
              : `Earlier conversation:`,
            histText,
            ``,
          ]
        : []),
      `The user now asks: ${p.question}`,
    ].join("\n");
    const client = seedClient(p.backend, p.cmd);
    const hint = p.backend === "claudeCli" ? randomUUID() : undefined;
    let reply = "";
    let sessionId: string | undefined;
    for await (const ev of client.stream({
      model: p.model,
      max_tokens: 4096,
      system: buildCoachSystemPrompt(p.lang),
      messages: [{ role: "user", content: prompt }],
      ...(hint ? { sessionIdHint: hint } : { captureSession: true }),
    })) {
      if (ev.delta) reply += ev.delta;
      if (ev.sessionId) sessionId = ev.sessionId;
    }
    if (!sessionId) throw new Error("播种未捕获到会话 id");
    return { sessionId, reply };
  }

  return {
    async getState(matchId: string): Promise<ChatState> {
      const { backend, lang, isCli } = ctx();
      if (!isCli) return { status: "unsupported" };
      const doc = readDoc(chatPath(deps.matchesDir, matchId, lang));
      const thread = doc.threads[backend];
      if (thread)
        return {
          status: "ready",
          backend,
          model: thread.model,
          messages: thread.messages,
          busy: inFlight.has(matchId),
        };
      const sess = findAnalysisSession(deps.matchesDir, matchId, lang, backend);
      if (!sess) return { status: "not-ready" };
      return {
        status: "ready",
        backend,
        model: sess.model,
        messages: [],
        busy: inFlight.has(matchId),
      };
    },

    async send(input: {
      matchId: string;
      question: string;
      seed?: ChatSeed;
    }): Promise<ChatSendResult> {
      const { backend, lang, cmd, isCli } = ctx();
      if (!isCli) return { status: "unsupported" };
      if (inFlight.has(input.matchId)) return { status: "busy" };
      const path = chatPath(deps.matchesDir, input.matchId, lang);
      const doc = readDoc(path);
      let thread = doc.threads[backend];
      if (!thread) {
        const sess = findAnalysisSession(
          deps.matchesDir,
          input.matchId,
          lang,
          backend,
        );
        if (!sess && !input.seed) return { status: "not-ready" };
        thread = {
          sessionId: sess?.sessionId ?? "",
          model:
            sess?.model ??
            resolveAiModel({
              aiBackend: backend as AiBackend,
              aiModels: deps.getSettings().aiModels,
            }),
          messages: [],
        };
      }
      const ac = new AbortController();
      inFlight.set(input.matchId, ac);
      try {
        let reply: string;
        if (input.seed) {
          // 自愈/无 session 播种:新 session,种子含上下文+结论+历史+新问
          const seeded = await seedNewSession({
            backend: backend as CliChatBackend,
            cmd,
            lang,
            model: thread.model,
            seed: input.seed,
            history: thread.messages,
            question: input.question,
            signal: ac.signal,
          });
          thread.sessionId = seeded.sessionId;
          reply = seeded.reply;
        } else {
          try {
            reply = await chatRunner({
              backend: backend as CliChatBackend,
              cmd,
              sessionId: thread.sessionId,
              question: input.question,
              model: thread.model,
              signal: ac.signal,
            });
          } catch {
            if (ac.signal.aborted)
              return { status: "error", message: "已停止" };
            return { status: "need-reseed" }; // renderer 构建 seed 后重调
          }
        }
        if (ac.signal.aborted) return { status: "error", message: "已停止" };
        const now = Date.now();
        thread.messages = [
          ...thread.messages,
          { role: "user", content: input.question, at: now },
          { role: "assistant", content: reply, at: now },
        ];
        doc.threads[backend] = thread;
        writeDoc(deps.matchesDir, input.matchId, path, doc);
        return { status: "ok", reply };
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      } finally {
        inFlight.delete(input.matchId);
      }
    },

    async cancel(matchId: string): Promise<void> {
      inFlight.get(matchId)?.abort();
    },
  };
}
