import type { AnthropicLike } from "./ai";

/** DeepSeek 官方 API 后端(OpenAI 兼容 chat/completions,SSE 流式)。
 * Node 20 内置 fetch,零新依赖。注意:非本地,prompt 会出机到
 * api.deepseek.com(用户 brainstorm 已确认接受)。 */
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// 整体硬顶,与 localAiBackends.ts 的 CLI 后端 TIMEOUT_MS 一致(同一份"分析
// 不该无限挂"的产品承诺,两条后端不该有两套上限)。
const TIMEOUT_MS = 300_000;
// 停滞看门狗:掐首字节(res.body 迟迟不来)和掐流中途卡死(拿到几个 chunk
// 后再无新数据)用同一套逻辑,每次拿到进展就重新计时。60s 取值理由:
// DeepSeek(含 R1 思维链)正常应答是持续吐 token/心跳,不该有分钟级静默;
// 60s 足够吞下一次网络抖动或供应商侧短暂卡顿,同时远小于 300s 总顶——
// 真卡死时用户不必等满 5 分钟才看到报错,又不会把正常的短暂延迟误杀。
const STALL_MS = 60_000;

interface SseDelta {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

// 通用 sk-xxxx 形态令牌(DeepSeek/OpenAI 兼容供应商的常见 key 前缀)。
const GENERIC_KEY_RE = /sk-[A-Za-z0-9]+/g;

/** 上游错误体可能回显请求头(含 Authorization)——原样透传会把 key 片段
 * 带到 UI 报错横幅上。抠掉配置的 key 本体 + 任何 sk-xxxx 形态令牌再抛。 */
export function scrubSecrets(text: string, key: string): string {
  let out = text;
  if (key) out = out.split(key).join("[REDACTED]");
  return out.replace(GENERIC_KEY_RE, "[REDACTED]");
}

/**
 * 把 `work` 跟"整体超时"与"停滞超时"两个看门狗一起 race:谁先决出就是
 * 结果。`work` 本体若在看门狗先触发后才决出,提前挂空 catch 防止变成
 * unhandledRejection(常见于 mock/真实 fetch 被 abort 后迟到的 rejection)。
 * stage 只影响错误文案(连接阶段 vs 流中途),行为一致。
 */
async function raceAgainstWatchdogs<T>(
  work: Promise<T>,
  overallDeadline: number,
  stallMs: number,
  stage: "connect" | "stream",
): Promise<T> {
  work.catch(() => {});
  const overallMs = Math.max(0, overallDeadline - Date.now());
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const overallPromise = new Promise<never>((_, reject) => {
    overallTimer = setTimeout(() => {
      reject(
        new Error(`DeepSeek 超时:请求整体超过 ${TIMEOUT_MS / 1000}s 未完成`),
      );
    }, overallMs);
  });
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setTimeout(() => {
      reject(
        new Error(
          stage === "connect"
            ? `DeepSeek 流停滞:连接阶段超过 ${stallMs / 1000}s 未收到响应`
            : `DeepSeek 流停滞:超过 ${stallMs / 1000}s 未收到新数据`,
        ),
      );
    }, stallMs);
  });
  try {
    return await Promise.race([work, overallPromise, stallPromise]);
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(stallTimer);
  }
}

// 退出时中止残留连接(quitLifecycle #21 item9):模块级追踪当前活跃的
// AbortController,进程退出前主动 abort 一遍,而不是指望宿主进程死掉后
// 连接自然断——完整性起见才加,此前不算 bug(宿主真退出后连接必然断)。
const activeControllers = new Set<AbortController>();

/** quitLifecycle 退出钩子调用:abort 所有仍在飞行中的 DeepSeek 请求。 */
export function abortAllDeepSeekStreams(): void {
  for (const c of activeControllers) {
    try {
      c.abort();
    } catch {
      // best-effort:退出流程不能因为这里报错而卡住。
    }
  }
}

export function deepseekClientFactory(
  key: string,
  fetchImpl: typeof fetch = fetch,
): AnthropicLike {
  return {
    async *stream(params) {
      const controller = new AbortController();
      activeControllers.add(controller);
      // 固定的绝对截止时刻:不随每次 chunk 重置,保证"多次短暂进展但总时长
      // 超标"的连接最终也会被砍断,而不是靠停滞窗口反复续命拖成无限。
      const overallDeadline = Date.now() + TIMEOUT_MS;

      let res: Response;
      try {
        res = await raceAgainstWatchdogs(
          fetchImpl(DEEPSEEK_URL, {
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
            signal: controller.signal,
          }),
          overallDeadline,
          STALL_MS,
          "connect",
        );
      } catch (e) {
        controller.abort();
        activeControllers.delete(controller);
        throw e;
      }
      if (!res.ok || !res.body) {
        activeControllers.delete(controller);
        const detail = await res.text().catch(() => "");
        throw new Error(
          `DeepSeek API ${res.status}: ${scrubSecrets(detail, key).slice(0, 300)}`,
        );
      }
      const decoder = new TextDecoder();
      let buf = "";
      const iterator = (res.body as unknown as AsyncIterable<Uint8Array>)[
        Symbol.asyncIterator
      ]();
      try {
        while (true) {
          const { value, done } = await raceAgainstWatchdogs(
            iterator.next(),
            overallDeadline,
            STALL_MS,
            "stream",
          );
          if (done) return;
          buf += decoder.decode(value, { stream: true });
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
      } catch (e) {
        controller.abort();
        throw e;
      } finally {
        // for-await-of 语法会在提前 return/throw 时自动调用迭代器的
        // return() 收尾;手动驱动迭代器(为了能跟看门狗 race)拿掉了这层
        // 自动行为,这里补回去,否则 [DONE]/看门狗提前退出时连接不会被
        // 主动关闭。
        if (typeof iterator.return === "function") {
          iterator.return().catch(() => {});
        }
        activeControllers.delete(controller);
      }
    },
  };
}
