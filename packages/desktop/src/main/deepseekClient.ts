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

/** 解析一行已去掉换行符的 SSE 文本行。返回 `done: true` 表示这是
 * `data: [DONE]`;否则返回该帧解出的 delta(取不到内容/非 JSON 心跳行则
 * 为 undefined)。单点抽出,好让"逐行正常解析"与"流结束时 flush 残留
 * buf"两处调用方共享同一份判据,不各写一套容易漂移。 */
function parseSseLine(rawLine: string): { done: boolean; delta?: string } {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return { done: false };
  const payload = line.slice(5).trim();
  if (payload === "[DONE]") return { done: true };
  try {
    const j = JSON.parse(payload) as SseDelta;
    // R1 的 reasoning_content(思维链)刻意不取:混进 JSON 输出
    // 会毒化 parseModelJsonArray 的解析。只吃 content。
    const delta = j.choices?.[0]?.delta?.content;
    return { done: false, delta: delta || undefined };
  } catch {
    /* 半帧已由 buf 兜住;这里只可能是心跳/注释行,忽略 */
    return { done: false };
  }
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
      // 是否已经真正收到 `[DONE]`。流物理结束(iterator done)时若这个还
      // 是 false,说明是服务端提前断连——不能当正常收尾静默放行,否则
      // 已产出的半截教练文本会被当成完整结果送出(观测:3/220 场,截断
      // 落在 1200~2100 字,远没到 max_tokens)。
      let sawDone = false;
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
          if (done) {
            // 先无参调用 decoder.decode() 做最终 flush:TextDecoder 在
            // {stream:true} 模式下,若上一个 value 的结尾恰好卡在一个多
            // 字节 UTF-8 序列中间,那半个字符的字节会留在 decoder 内部状
            // 态里,不会出现在任何一次 decode() 的返回值中。物理流结束后
            // 不会再有后续 value 补全它,若不在这里做一次无参 flush 主动
            // 要回来,这些字节会随 decoder 一起被丢弃——静默到连 U+FFFD
            // 替换字符都不会有(经验证不是"解析失败"而是"根本没进 buf")。
            // flush 之后 buf 才是这次连接收到的全部字节的完整解码结果,
            // 下面"按完整行扫一遍 + 处理尾部无换行残帧"的逻辑才成立。
            buf += decoder.decode();
            // flush 残留 buf:可能还压着一个没跟换行符的完整帧(服务端在
            // JSON 帧末尾、换行符之前就把连接断了)。先按"完整行"扫一遍
            // (万一 buf 里还有内部换行),再把剩下、没有换行符收尾的那一
            // 截当独立一帧试解析——解得出就是该帧的 delta,解不出就是真
            // 半截/空尾,忽略。
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              const parsed = parseSseLine(line);
              if (parsed.done) {
                sawDone = true;
                break;
              }
              if (parsed.delta) yield { delta: parsed.delta };
            }
            if (!sawDone && buf.trim()) {
              const parsed = parseSseLine(buf);
              if (parsed.done) sawDone = true;
              else if (parsed.delta) yield { delta: parsed.delta };
            }
            if (!sawDone) {
              throw new Error(
                "DeepSeek 流异常提前结束(未收到 [DONE]):服务端提前断连,输出可能被截断,已按失败处理",
              );
            }
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const parsed = parseSseLine(line);
            if (parsed.done) {
              sawDone = true;
              return;
            }
            if (parsed.delta) yield { delta: parsed.delta };
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
