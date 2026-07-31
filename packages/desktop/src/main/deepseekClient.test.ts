import { describe, expect, it, vi } from "vitest";
import {
  abortAllDeepSeekStreams,
  deepseekClientFactory,
  scrubSecrets,
} from "./deepseekClient";

const enc = new TextEncoder();

function fakeFetch(opts: {
  status?: number;
  chunks?: string[];
  captured?: { body?: unknown };
  errorText?: string;
}) {
  return (async (_url: unknown, init?: { body?: string }) => {
    if (opts.captured) opts.captured.body = JSON.parse(init?.body ?? "{}");
    const ok = (opts.status ?? 200) === 200;
    return {
      ok,
      status: opts.status ?? 200,
      text: async () => opts.errorText ?? "boom detail",
      body: ok
        ? (async function* () {
            for (const c of opts.chunks ?? []) yield enc.encode(c);
          })()
        : null,
    };
  }) as unknown as typeof fetch;
}

/** body 是一个真的挂起(永不 resolve/reject)的异步可迭代对象——模拟连接
 * 建立后中途卡死(无新 chunk、也无 [DONE]、也不报错)。用于验证停滞看门狗
 * 不依赖底层 iterable 自己响应 abort 信号也能让调用方跳出循环。 */
function stalledBodyFetch() {
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}), // 永不决出
        };
      },
    },
  })) as unknown as typeof fetch;
}

/** 每次被消费都立刻吐一个 chunk,但吐的节奏比停滞窗口短、累计比整体上限
 * 长——用于验证"没有单次停滞,但总时长超标"也会被整体硬顶掐断。 */
function slowDripFetch(chunkIntervalMs: number, chunkCount: number) {
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                i += 1;
                resolve({
                  value: enc.encode(
                    `data: {"choices":[{"delta":{"content":"x${i}"}}]}\n`,
                  ),
                  done: i > chunkCount,
                });
              }, chunkIntervalMs);
            }),
        };
      },
    },
  })) as unknown as typeof fetch;
}

/** body 逐个吐出预先切好的原始字节块——用于精确控制多字节 UTF-8 字符
 * 被切在哪个字节偏移上,普通 `chunks: string[]` helper 做不到(每个字符串
 * 各自单独 encode,天然落在字符边界上)。 */
function rawChunkFetch(chunks: Uint8Array[]) {
  return (async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    body: (async function* () {
      for (const c of chunks) yield c;
    })(),
  })) as unknown as typeof fetch;
}

async function collect(client: ReturnType<typeof deepseekClientFactory>) {
  const out: string[] = [];
  for await (const ev of client.stream({
    model: "deepseek-chat",
    max_tokens: 100,
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (ev.delta) out.push(ev.delta);
  }
  return out;
}

describe("deepseekClientFactory", () => {
  it("SSE 跨块半帧拼接;[DONE] 终止;system 转 messages 首条", async () => {
    const captured: { body?: unknown } = {};
    const client = deepseekClientFactory(
      "k",
      fakeFetch({
        captured,
        chunks: [
          'data: {"choices":[{"delta":{"content":"你"}}]}\n',
          'data: {"choices":[{"delta":{"con', // 半帧
          'tent":"好"}}]}\n',
          "data: [DONE]\n",
          'data: {"choices":[{"delta":{"content":"不该出现"}}]}\n',
        ],
      }),
    );
    expect(await collect(client)).toEqual(["你", "好"]);
    const body = captured.body as {
      stream: boolean;
      messages: Array<{ role: string }>;
    };
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("reasoning_content(R1 思维链)帧不产出 delta", async () => {
    const client = deepseekClientFactory(
      "k",
      fakeFetch({
        chunks: [
          'data: {"choices":[{"delta":{"reasoning_content":"想…","content":null}}]}\n',
          'data: {"choices":[{"delta":{"content":"答"}}]}\n',
          "data: [DONE]\n",
        ],
      }),
    );
    expect(await collect(client)).toEqual(["答"]);
  });

  it("非 200:抛错并带状态码与摘要", async () => {
    const client = deepseekClientFactory("k", fakeFetch({ status: 402 }));
    await expect(collect(client)).rejects.toThrow(/DeepSeek API 402.*boom/);
  });

  it("非 200 且错误体回显了配置的 key:抛出的错误信息里 key 已被抹除", async () => {
    const key = "sk-abcDEF1234567890realKey";
    const client = deepseekClientFactory(
      key,
      fakeFetch({
        status: 401,
        errorText: `missing authentication string, got Bearer ${key}`,
      }),
    );
    const err = await collect(client).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("DeepSeek API 401");
    expect(err!.message).not.toContain(key);
    expect(err!.message).toContain("[REDACTED]");
  });

  it("多字节 UTF-8 字符被切在原始字节 chunk 边界:{stream:true} 解码后仍完整", async () => {
    // prefix 全 ASCII,字节长度 == 字符长度,可以精确算出"中"的起始字节
    // 偏移,再往后切 1 字节——切点保证落在"中"(E4 B8 AD)的第二个字节上。
    const prefix = 'data: {"choices":[{"delta":{"content":"';
    const suffix = '"}}]}\n';
    const full = enc.encode(prefix + "中文测试" + suffix);
    const splitAt = prefix.length + 1;
    const client = deepseekClientFactory(
      "k",
      rawChunkFetch([
        full.slice(0, splitAt),
        full.slice(splitAt),
        enc.encode("data: [DONE]\n"),
      ]),
    );
    expect(await collect(client)).toEqual(["中文测试"]);
  });

  it("流中途卡死(无新 chunk、无 [DONE]、无报错):停滞看门狗到点触发,报错清晰、不挂起", async () => {
    vi.useFakeTimers();
    try {
      const client = deepseekClientFactory("k", stalledBodyFetch());
      const gen = client
        .stream({
          model: "deepseek-chat",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        })
        [Symbol.asyncIterator]();
      const pending = gen.next();
      const assertion = expect(pending).rejects.toThrow(/DeepSeek 流停滞/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("持续有进展但单次间隔都低于停滞阈值:总时长超过整体上限仍会被硬顶掐断", async () => {
    vi.useFakeTimers();
    try {
      // 每 50s 吐一个 chunk(< 60s 停滞阈值,单次都不触发停滞看门狗),
      // 累计跑到 7*50s=350s > 300s 整体上限。
      const client = deepseekClientFactory("k", slowDripFetch(50_000, 10));
      const gen = client
        .stream({
          model: "deepseek-chat",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        })
        [Symbol.asyncIterator]();
      const resultPromise = (async () => {
        try {
          for (;;) {
            const r = await gen.next();
            if (r.done) return { ok: true as const };
          }
        } catch (e) {
          return { ok: false as const, error: e as Error };
        }
      })();
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
      }
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.message).toMatch(/DeepSeek 超时/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("abortAllDeepSeekStreams(#21 item9:quitLifecycle 完整性收尾)", () => {
  it("红→绿:中止飞行中请求的 AbortSignal,连接阶段的 fetch 随之 reject", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = (async (
      _url: unknown,
      init?: { signal?: AbortSignal },
    ) => {
      capturedSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;
    const client = deepseekClientFactory("k", fetchImpl);
    const iterator = client
      .stream({
        model: "m",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    expect(capturedSignal?.aborted).toBe(false);

    abortAllDeepSeekStreams();

    expect(capturedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("没有飞行中的请求时调用不报错(idempotent/no-op)", () => {
    expect(() => abortAllDeepSeekStreams()).not.toThrow();
  });

  it("请求正常结束后不再被追踪:后续 abortAllDeepSeekStreams() 不影响已完成的流", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n');
        yield new TextEncoder().encode("data: [DONE]\n");
      })(),
    })) as unknown as typeof fetch;
    const client = deepseekClientFactory("k", fetchImpl);
    const chunks: string[] = [];
    for await (const ev of client.stream({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (ev.delta) chunks.push(ev.delta);
    }
    // 跑完之后调用不应抛出(controller 已经从追踪集合里移除)。
    expect(() => abortAllDeepSeekStreams()).not.toThrow();
  });
});

describe("scrubSecrets", () => {
  it("抹掉配置的 key 本体与通用 sk-xxxx 形态令牌", () => {
    expect(
      scrubSecrets(
        "Bearer sk-configuredKey123 rejected",
        "sk-configuredKey123",
      ),
    ).toBe("Bearer [REDACTED] rejected");
    // 配置的 key 之外,泄漏了别的 sk- 形态 token 也要兜住(通用正则)。
    expect(
      scrubSecrets("leaked sk-someOtherToken999 too", "sk-configuredKey123"),
    ).toBe("leaked [REDACTED] too");
  });

  it("没有可疑内容时原样返回", () => {
    expect(scrubSecrets("plain error text", "sk-configuredKey123")).toBe(
      "plain error text",
    );
  });
});
