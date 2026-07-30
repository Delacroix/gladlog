import { describe, expect, it } from "vitest";
import { deepseekClientFactory } from "./deepseekClient";

const enc = new TextEncoder();

function fakeFetch(opts: {
  status?: number;
  chunks?: string[];
  captured?: { body?: unknown };
}) {
  return (async (_url: unknown, init?: { body?: string }) => {
    if (opts.captured) opts.captured.body = JSON.parse(init?.body ?? "{}");
    const ok = (opts.status ?? 200) === 200;
    return {
      ok,
      status: opts.status ?? 200,
      text: async () => "boom detail",
      body: ok
        ? (async function* () {
            for (const c of opts.chunks ?? []) yield enc.encode(c);
          })()
        : null,
    };
  }) as unknown as typeof fetch;
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
});
