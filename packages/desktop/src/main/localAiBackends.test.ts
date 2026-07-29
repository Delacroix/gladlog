import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agyClientFactory,
  claudeCliClientFactory,
  codexClientFactory,
  stripAgyHeader,
  type Runner,
} from "./localAiBackends";
import { resolveAiClient, type AnthropicLike } from "./ai";

async function collect(client: AnthropicLike): Promise<string> {
  let out = "";
  for await (const ev of client.stream({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (ev.delta) out += ev.delta;
  }
  return out;
}

describe("local AI backends", () => {
  it("claudeCli yields stdout as a delta and writes the prompt to stdin", async () => {
    let gotStdin = "";
    let gotArgs: string[] = [];
    const run: Runner = async (_file, args, stdin) => {
      gotStdin = stdin;
      gotArgs = args;
      return "FINDINGS_JSON";
    };
    expect(await collect(claudeCliClientFactory({ cmd: "claude", run }))).toBe(
      "FINDINGS_JSON",
    );
    expect(gotStdin).toBe("hi");
    expect(gotArgs).toContain("-p");
  });

  it("agy strips the [agy-run] header line", async () => {
    const run: Runner = async () =>
      "[agy-run] role=ask model=x\nREAL BODY\nmore";
    const a = agyClientFactory({ node: "node", script: "/x/agy.mjs", run });
    expect(await collect(a)).toBe("REAL BODY\nmore");
  });

  it("passes the prompt as an args element (no shell), not stdin, for agy", async () => {
    let gotArgs: string[] = [];
    const run: Runner = async (_f, args) => {
      gotArgs = args;
      return "ok";
    };
    await collect(agyClientFactory({ node: "node", script: "/x", run }));
    expect(gotArgs).toEqual([
      "/x",
      "ask",
      "--model",
      "m",
      "--timeout",
      "110",
      "hi",
    ]);
  });

  it("两个本地后端都把 params.model 透传成 --model(否则模型下拉对它们是摆设)", async () => {
    const seen: Record<string, string[]> = {};
    const capture =
      (key: string): Runner =>
      async (_f, args) => {
        seen[key] = args;
        return "ok";
      };
    await collect(
      claudeCliClientFactory({ cmd: "claude", run: capture("claudeCli") }),
    );
    await collect(
      agyClientFactory({ node: "node", script: "/x", run: capture("agy") }),
    );
    for (const key of ["claudeCli", "agy"]) {
      const args = seen[key];
      expect(args[args.indexOf("--model") + 1]).toBe("m");
    }
  });

  it("non-zero exit surfaces as an error (not silent)", async () => {
    const run: Runner = async () => {
      throw new Error("claude exited 1: boom");
    };
    await expect(
      collect(claudeCliClientFactory({ cmd: "claude", run })),
    ).rejects.toThrow(/exited 1/);
  });

  it("stripAgyHeader leaves non-header output alone", () => {
    expect(stripAgyHeader("PONG")).toBe("PONG");
  });

  it("agy 直调模式:--print/--model/--print-timeout/--new-project/--sandbox,不再依赖包装脚本", async () => {
    let gotFile = "";
    let gotArgs: string[] = [];
    const run: Runner = async (file, args) => {
      gotFile = file;
      gotArgs = args;
      return "REPLY";
    };
    expect(await collect(agyClientFactory({ cmd: "/bin/agy", run }))).toBe(
      "REPLY",
    );
    expect(gotFile).toBe("/bin/agy");
    expect(gotArgs[gotArgs.indexOf("--print") + 1]).toBe("hi");
    // 未知 id 原样透传(collect 用的 model 是 "m")
    expect(gotArgs[gotArgs.indexOf("--model") + 1]).toBe("m");
    expect(gotArgs).toContain("--new-project");
    expect(gotArgs).toContain("--sandbox");
    expect(gotArgs[gotArgs.indexOf("--print-timeout") + 1]).toBe("110s");
  });

  it("agy 直调:alias id 映射成 CLI 模型全名(pro → Gemini 3.1 Pro (High))", async () => {
    let gotArgs: string[] = [];
    const run: Runner = async (_f, args) => {
      gotArgs = args;
      return "ok";
    };
    const client = agyClientFactory({ cmd: "/bin/agy", run });
    for await (const _ of client.stream({
      model: "pro",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }
    expect(gotArgs[gotArgs.indexOf("--model") + 1]).toBe(
      "Gemini 3.1 Pro (High)",
    );
  });

  it("agy 直调:直调输出不剥头行(agy stdout 本来就是干净回复)", async () => {
    const run: Runner = async () => "[agy-run] 长得像头行但其实是回复\nbody";
    // cmd 不是 .mjs → 直调模式,输出原样保留
    const out = await collect(agyClientFactory({ cmd: "/bin/agy", run }));
    expect(out).toBe("[agy-run] 长得像头行但其实是回复\nbody");
  });

  it("agy 兼容:cmd 以 .mjs 结尾 → 走旧 node+包装脚本模式并剥头行", async () => {
    let gotFile = "";
    let gotArgs: string[] = [];
    const run: Runner = async (file, args) => {
      gotFile = file;
      gotArgs = args;
      return "[agy-run] role=ask\nREAL";
    };
    const out = await collect(
      agyClientFactory({ cmd: "/x/agy-run.mjs", node: "node", run }),
    );
    expect(out).toBe("REAL");
    expect(gotFile).toBe("node");
    expect(gotArgs[0]).toBe("/x/agy-run.mjs");
    expect(gotArgs).toContain("ask");
  });

  it("agy 兼容:legacy .mjs 模式在 win32 上同样受 argv 守卫(agy flash 复核 #3)", async () => {
    const run: Runner = async () => "should not run";
    const client = agyClientFactory({
      cmd: "/x/agy-run.mjs",
      node: "node",
      platform: "win32",
      run,
    });
    const big = "x".repeat(30_001);
    await expect(
      collect({
        stream: (p) =>
          client.stream({ ...p, messages: [{ role: "user", content: big }] }),
      } as AnthropicLike),
    ).rejects.toThrow(/32K/);
  });

  it("agy 直调:win32 经 cmd.exe 跑 .cmd 时上限降到 8K(agy flash 复核 #4)", async () => {
    const run: Runner = async () => "ok";
    const mid = "x".repeat(8_000); // 8K < 30K:.cmd 拦,.exe 放行
    const viaBatch = agyClientFactory({
      cmd: "C:\\npm\\agy.cmd",
      platform: "win32",
      run,
    });
    await expect(
      collect({
        stream: (p) =>
          viaBatch.stream({ ...p, messages: [{ role: "user", content: mid }] }),
      } as AnthropicLike),
    ).rejects.toThrow(/8K/);
    const viaExe = agyClientFactory({
      cmd: "C:\\bin\\agy.exe",
      platform: "win32",
      run,
    });
    await expect(
      collect({
        stream: (p) =>
          viaExe.stream({ ...p, messages: [{ role: "user", content: mid }] }),
      } as AnthropicLike),
    ).resolves.toBe("ok");
  });

  it("agy 直调:win32 上超长 prompt 明确报错(命令行 32K 上限),不静默截断", async () => {
    const run: Runner = async () => "should not run";
    const client = agyClientFactory({
      cmd: "/bin/agy",
      platform: "win32",
      run,
    });
    const big = "x".repeat(30_001);
    await expect(
      collect({
        stream: (p) =>
          client.stream({ ...p, messages: [{ role: "user", content: big }] }),
      } as AnthropicLike),
    ).rejects.toThrow(/32K/);
    // 同样的 prompt 在 mac 上不受限
    const okClient = agyClientFactory({
      cmd: "/bin/agy",
      platform: "darwin",
      run,
    });
    await expect(
      collect({
        stream: (p) =>
          okClient.stream({
            ...p,
            messages: [{ role: "user", content: big }],
          }),
      } as AnthropicLike),
    ).resolves.toBe("should not run");
  });

  it("codex 拼装 exec/-/-m/model/sandbox read-only/-o 参数,prompt 走 stdin", async () => {
    let gotStdin = "";
    let gotArgs: string[] = [];
    const run: Runner = async (_file, args, stdin) => {
      gotStdin = stdin;
      gotArgs = args;
      return "";
    };
    await collect(codexClientFactory({ cmd: "codex", run }));
    expect(gotStdin).toBe("hi");
    expect(gotArgs).toContain("exec");
    expect(gotArgs).toContain("-");
    expect(gotArgs[gotArgs.indexOf("-m") + 1]).toBe("m");
    expect(gotArgs).toContain("--sandbox");
    expect(gotArgs[gotArgs.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(gotArgs).toContain("-o");
  });

  it("codex 优先取 -o 文件内容(stdout 混杂 agent 日志,不是干净回复)", async () => {
    const run: Runner = async (_file, args) => {
      const outFile = args[args.indexOf("-o") + 1];
      writeFileSync(outFile, "CLEAN REPLY FROM FILE", "utf-8");
      return "noisy agent log lines mixed with the reply";
    };
    const out = await collect(codexClientFactory({ cmd: "codex", run }));
    expect(out).toBe("CLEAN REPLY FROM FILE");
  });

  it("codex 回退用 stdout(仅当 -o 文件缺失,readFileSync 抛错时)", async () => {
    let outFileSeen = "";
    const run: Runner = async (_file, args) => {
      outFileSeen = args[args.indexOf("-o") + 1];
      // 故意不写文件,模拟旧版本 codex 不认识 -o。
      return "FALLBACK STDOUT";
    };
    const out = await collect(codexClientFactory({ cmd: "codex", run }));
    expect(out).toBe("FALLBACK STDOUT");
    // finally 里 best-effort 清理:不存在的文件 unlink 不应抛出,且清理后确实不留下垃圾。
    expect(existsSync(outFileSeen)).toBe(false);
  });

  it("codex -o 文件存在但内容为空 → delta 为空串,不回退脏 stdout(空回复是合法模型输出)", async () => {
    const run: Runner = async (_file, args) => {
      const outFile = args[args.indexOf("-o") + 1];
      writeFileSync(outFile, "", "utf-8");
      return "noisy agent log lines that must NOT leak through";
    };
    const out = await collect(codexClientFactory({ cmd: "codex", run }));
    expect(out).toBe("");
  });

  it("codex 透传 params.model 成 -m(否则模型下拉是摆设)", async () => {
    let gotArgs: string[] = [];
    const run: Runner = async (_f, args) => {
      gotArgs = args;
      return "ok";
    };
    await collect(codexClientFactory({ cmd: "codex", run }));
    expect(gotArgs[gotArgs.indexOf("-m") + 1]).toBe("m");
  });
});

describe("resolveAiClient", () => {
  it("returns a client for the claudeCli backend with no API key", () => {
    expect(
      resolveAiClient({ anthropicApiKey: null, aiBackend: "claudeCli" }),
    ).not.toBeNull();
  });
  it("returns a client for the agy backend with no API key", () => {
    expect(
      resolveAiClient({ anthropicApiKey: null, aiBackend: "agy" }),
    ).not.toBeNull();
  });
  it("returns a client for the codex backend with no API key", () => {
    expect(
      resolveAiClient({ anthropicApiKey: null, aiBackend: "codex" }),
    ).not.toBeNull();
  });
  it("anthropic backend without a key returns null (falls back)", () => {
    expect(
      resolveAiClient({ anthropicApiKey: null, aiBackend: "anthropic" }),
    ).toBeNull();
  });
  it("anthropic backend with a key returns a client", () => {
    expect(
      resolveAiClient({ anthropicApiKey: "sk-x", aiBackend: "anthropic" }),
    ).not.toBeNull();
  });
});

describe("system prompt 经本地后端(backlog #1)", () => {
  it("claudeCli:system 拼接在 prompt 最前", async () => {
    const seen: string[] = [];
    const client = claudeCliClientFactory({
      cmd: "claude",
      run: async (_cmd, _args, stdin) => {
        seen.push(stdin);
        return "ok";
      },
    });
    for await (const _ of client.stream({
      model: "m",
      max_tokens: 1,
      system: "SYS-LANG",
      messages: [{ role: "user", content: "PROMPT" }],
    })) {
      /* drain */
    }
    expect(seen[0]).toBe("SYS-LANG\nPROMPT");
  });
});
