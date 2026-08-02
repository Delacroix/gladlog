import {
  agyClientFactory,
  claudeCliClientFactory,
  codexClientFactory,
  killAllCliChildren,
} from "./localAiBackends";
import {
  abortAllDeepSeekStreams,
  deepseekClientFactory,
} from "./deepseekClient";

/**
 * quitLifecycle 退出钩子调用(#21 item9,完整性修复,非 bug——宿主进程
 * 退出后这些连接/子进程本就会自然断/变孤儿被系统回收):把飞行中的本地
 * CLI 子进程(claude/agy/codex)与 DeepSeek fetch 一起收掉,而不是分头
 * 各自记一份。两条后端各自的追踪集合(activeChildren/activeControllers)
 * 仍留在各自模块里——这里只是聚合入口。
 */
export function stopAllAiActivity(): void {
  killAllCliChildren();
  abortAllDeepSeekStreams();
}

export { PROMPT_VERSION } from "../shared/promptVersion";

export interface AnthropicLike {
  stream(params: {
    model: string;
    max_tokens: number;
    /** 教练角色 + 输出语言指令(backlog #1);本地后端拼接到 prompt 前。 */
    system?: string;
    messages: { role: "user"; content: string }[];
    /** coach chat(2026-08-02 spec):claudeCli 专用 —— 由调用方生成 UUID,
     * 工厂追加 `--session-id <hint>` 并在文本后 yield {sessionId: hint}。 */
    sessionIdHint?: string;
    /** coach chat:agy/codex 专用 —— 切到可捕获会话 id 的输出格式并
     * yield {sessionId}。捕获失败不抛错,只是没有 sessionId 事件。 */
    captureSession?: boolean;
    /** 种子阶段停止修复(终审 F1):coach chat 播种新 session
     * (coachChat.ts 的 seedNewSession)此前接了 AbortSignal 却从没往下传,
     * 用户按「停止」杀不掉正在播种的本地 CLI 子进程——三家本地 CLI 工厂
     * (claudeCliClientFactory/agyClientFactory/codexClientFactory)经
     * Runner 第 4 参把它转发给 defaultRun 真正 SIGKILL;
     * realClientFactory(Anthropic API)与 deepseek 可以忽略这个参数,
     * 各自走自己的取消通路,不在本次修复范围内。 */
    signal?: AbortSignal;
  }): AsyncIterable<{ delta?: string; sessionId?: string }>;
}

export type AiLanguage = "zh" | "en";

/**
 * 教练系统提示(backlog #1):角色设定 + 输出语言。语言是请求参数而非
 * prompt 构建器改动 —— PROMPT_VERSION 不 bump;时间轴 prompt 本体保持英文。
 */
export function buildCoachSystemPrompt(lang: AiLanguage): string {
  const language =
    lang === "zh"
      ? "Respond entirely in Simplified Chinese (简体中文). Keep spell/ability names in English exactly as written in the data — never translate them into Chinese, even inline; you may explain them in Chinese, but the name token itself must stay English."
      : "Respond in English.";
  return `You are a World of Warcraft arena coach reviewing a player's match. Be direct, specific, and grounded strictly in the provided events. ${language}`;
}

export type { AiBackend } from "../shared/aiModels";
import type { AiBackend, AiModelSelection } from "../shared/aiModels";

export interface AiClientSettings {
  anthropicApiKey: string | null;
  deepseekApiKey?: string | null;
  aiBackend?: AiBackend | null;
  aiBackendCommand?: string | null;
  /**
   * resolveAiClient 本身不读这个字段(backend 已经够它挑工厂了)——列出
   * 只是为了让 run() 传入 {...settings, aiBackend, aiModels} 这个 backendOverride
   * 融合快照时不撞 TS 的多余属性检查(调用方与 resolveAiModel 共用同一份
   * settings 快照,字段形状本该一致)。
   */
  aiModels?: AiModelSelection | null;
}

/**
 * Pick the LLM client for the configured backend. Local backends (claudeCli,
 * agy, codex) need no API key; the Anthropic backend returns null without one
 * so the service falls back to deterministic output.
 */
export function resolveAiClient(
  settings: AiClientSettings,
  anthropicFactory?: (key: string) => AnthropicLike,
): AnthropicLike | null {
  const backend = settings.aiBackend ?? "anthropic";
  const cmd = settings.aiBackendCommand || undefined;
  if (backend === "claudeCli") return claudeCliClientFactory({ cmd });
  // cmd 以 .mjs 结尾时 agyClientFactory 内部走旧包装脚本兼容模式
  if (backend === "agy") return agyClientFactory({ cmd });
  if (backend === "codex") return codexClientFactory({ cmd });
  // DeepSeek 官方 API:同 anthropic 语义 —— 无 key → null → 确定性回退
  if (backend === "deepseek")
    return settings.deepseekApiKey
      ? deepseekClientFactory(settings.deepseekApiKey)
      : null;
  if (!settings.anthropicApiKey) return null;
  return (anthropicFactory ?? realClientFactory)(settings.anthropicApiKey);
}

export function realClientFactory(key: string): AnthropicLike {
  return {
    async *stream(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: { role: "user"; content: string }[];
    }): AsyncIterable<{ delta?: string }> {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });
      const stream = await client.messages.stream({
        model: params.model,
        max_tokens: params.max_tokens,
        ...(params.system ? { system: params.system } : {}),
        messages: params.messages,
      });

      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield { delta: event.delta.text };
          }
        }
      } finally {
        // 消费方提前 break(取消)时确保底层 HTTP 流被挂断
        stream.abort();
      }
    },
  };
}
