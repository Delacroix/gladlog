import type { AnthropicLike } from "./ai";

/** DeepSeek 官方 API 后端(OpenAI 兼容 chat/completions,SSE 流式)。
 * Node 20 内置 fetch,零新依赖。注意:非本地,prompt 会出机到
 * api.deepseek.com(用户 brainstorm 已确认接受)。 */
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

interface SseDelta {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export function deepseekClientFactory(
  key: string,
  fetchImpl: typeof fetch = fetch,
): AnthropicLike {
  return {
    async *stream(params) {
      const res = await fetchImpl(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: params.model,
          max_tokens: params.max_tokens,
          stream: true,
          messages: [
            ...(params.system
              ? [{ role: "system", content: params.system }]
              : []),
            ...params.messages,
          ],
        }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`DeepSeek API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const j = JSON.parse(payload) as SseDelta;
            // R1 的 reasoning_content(思维链)刻意不取:混进 JSON 输出
            // 会毒化 parseModelJsonArray 的解析。只吃 content。
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) yield { delta };
          } catch {
            /* 半帧已由 buf 兜住;这里只可能是心跳/注释行,忽略 */
          }
        }
      }
    },
  };
}
