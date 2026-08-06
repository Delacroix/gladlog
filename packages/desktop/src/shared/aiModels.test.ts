import { describe, expect, it } from "vitest";

import {
  AI_BACKENDS,
  AI_DEFAULT_MODEL,
  AI_MODELS,
  isKnownModel,
  resolveAiModel,
  resolveDeepDiveSnapshot,
} from "./aiModels";

describe("aiModels catalog", () => {
  it("每个后端都有非空模型表,且默认值在表内", () => {
    for (const backend of AI_BACKENDS) {
      expect(AI_MODELS[backend].length).toBeGreaterThan(0);
      expect(isKnownModel(backend, AI_DEFAULT_MODEL[backend])).toBe(true);
    }
  });

  it("同一后端内 model id 不重复", () => {
    for (const backend of AI_BACKENDS) {
      const ids = AI_MODELS[backend].map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("resolveAiModel", () => {
  it("无设置时按后端取默认值", () => {
    expect(resolveAiModel({})).toBe("claude-sonnet-5");
    expect(resolveAiModel({ aiBackend: "agy" })).toBe("pro");
    expect(resolveAiModel({ aiBackend: "claudeCli" })).toBe("claude-sonnet-5");
  });

  it("取当前后端那一格,不串用别的后端的选择", () => {
    const aiModels = { anthropic: "claude-opus-4-8", agy: "flash" };
    expect(resolveAiModel({ aiBackend: "anthropic", aiModels })).toBe(
      "claude-opus-4-8",
    );
    expect(resolveAiModel({ aiBackend: "agy", aiModels })).toBe("flash");
    // Nothing stored in the claudeCli slot -> the default, not a borrowed
    // anthropic value
    expect(resolveAiModel({ aiBackend: "claudeCli", aiModels })).toBe(
      "claude-sonnet-5",
    );
  });

  it("存了跨后端的非法 id 时退回默认值", () => {
    // An agy alias fed to the anthropic backend is invalid
    expect(
      resolveAiModel({
        aiBackend: "anthropic",
        aiModels: { anthropic: "pro" },
      }),
    ).toBe("claude-sonnet-5");
    expect(
      resolveAiModel({
        aiBackend: "agy",
        aiModels: { agy: "claude-sonnet-5" },
      }),
    ).toBe("pro");
  });
});

describe("resolveDeepDiveSnapshot(knob 决议 2026-08-05:仅 CLI 后端生效)", () => {
  it("CLI 后端 + 开关开 → true;三个 CLI 后端一视同仁", () => {
    for (const b of ["claudeCli", "agy", "codex"] as const) {
      expect(
        resolveDeepDiveSnapshot({ aiBackend: b, deepDiveSnapshot: true }),
      ).toBe(true);
    }
  });
  it("API 后端(anthropic/deepseek)即使开关开 → false(按 token 计费不生效)", () => {
    for (const b of ["anthropic", "deepseek"] as const) {
      expect(
        resolveDeepDiveSnapshot({ aiBackend: b, deepDiveSnapshot: true }),
      ).toBe(false);
    }
  });
  it("开关关/缺省 → false;backend 缺省按 anthropic(默认后端)→ false", () => {
    expect(
      resolveDeepDiveSnapshot({
        aiBackend: "claudeCli",
        deepDiveSnapshot: false,
      }),
    ).toBe(false);
    expect(resolveDeepDiveSnapshot({ aiBackend: "claudeCli" })).toBe(false);
    expect(resolveDeepDiveSnapshot({ deepDiveSnapshot: true })).toBe(false);
    expect(resolveDeepDiveSnapshot({})).toBe(false);
  });
});
