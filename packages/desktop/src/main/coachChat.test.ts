import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCoachChatService } from "./coachChat";
import { PROMPT_VERSION } from "../shared/promptVersion";

function seedAnalysisCache(
  dir: string,
  matchId: string,
  opts?: { sessionId?: string },
) {
  mkdirSync(join(dir, matchId), { recursive: true });
  writeFileSync(
    join(dir, matchId, "analysis-v2.zh.json"),
    JSON.stringify({
      schemaVersion: 2,
      language: "zh",
      lastSlotKey: "claudeCli:claude-sonnet-5",
      slots: {
        "claudeCli:claude-sonnet-5": {
          promptVersion: PROMPT_VERSION,
          createdAt: 1,
          result: {
            findings: [],
            dropped: 0,
            hadNarration: true,
            ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
          },
        },
      },
    }),
  );
}

const settings = () => ({
  aiBackend: "claudeCli" as const,
  aiBackendCommand: null,
  aiLanguage: "zh" as const,
});

it("门槛:API 后端 unsupported;无分析 session not-ready;有则 ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  const svc = createCoachChatService({
    getSettings: () => ({ ...settings(), aiBackend: "anthropic" as const }),
    matchesDir: dir,
  });
  expect((await svc.getState("m1")).status).toBe("unsupported");

  const svc2 = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  expect((await svc2.getState("m1")).status).toBe("not-ready");
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const st = await svc2.getState("m1");
  expect(st.status).toBe("ready");
  expect((st as { model: string }).model).toBe("claude-sonnet-5");
});

it("旧缓存无 sessionId → not-ready(重新分析才解锁)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1"); // 无 sessionId
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  expect((await svc.getState("m1")).status).toBe("not-ready");
});

it("send:resume 成功,消息追加并落盘;重开服务能读回(续聊)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async (_params?: unknown) => "教练回答");
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  const r = await svc.send({ matchId: "m1", question: "问" });
  expect(r).toEqual({ status: "ok", reply: "教练回答" });
  expect(chatRunner.mock.calls[0]![0]).toMatchObject({
    backend: "claudeCli",
    sessionId: "sid-a",
    question: "问",
    model: "claude-sonnet-5",
  });
  // 落盘 + 新实例读回
  const svc2 = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
  });
  const st = (await svc2.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});

it("send:resume 失败且无 seed → need-reseed;带 seed → 播种新 session 后重问", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-dead" });
  const chatRunner = vi
    .fn()
    .mockRejectedValueOnce(new Error("session not found"))
    .mockResolvedValue("自愈后的回答");
  // seedClient 桩:captureSession 播种,yield 回答 + 新 sessionId
  const seedClient = () => ({
    async *stream(params: { sessionIdHint?: string }) {
      yield { delta: "播种回答(含新问题的答案)" };
      yield { sessionId: params.sessionIdHint ?? "new-sid" };
    },
  });
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
    seedClient: seedClient as never,
  });
  const r1 = await svc.send({ matchId: "m1", question: "问" });
  expect(r1).toEqual({ status: "need-reseed" });
  const r2 = await svc.send({
    matchId: "m1",
    question: "问",
    seed: { richContext: "CTX", spec: "Holy Paladin", findingsSummary: "F1" },
  });
  expect(r2.status).toBe("ok");
  // 线程 sessionId 已更新为新 id(自愈)
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2); // user + assistant(need-reseed 那次不落盘)
});

it("并发守卫:同场在飞时再 send 得 busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  let release!: () => void;
  const gate = new Promise<string>((r) => (release = () => r("慢回答")));
  const chatRunner = vi.fn(() => gate);
  const svc = createCoachChatService({
    getSettings: settings,
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  const p1 = svc.send({ matchId: "m1", question: "a" });
  const r2 = await svc.send({ matchId: "m1", question: "b" });
  expect(r2.status).toBe("busy");
  release();
  await p1;
});

it("每 CLI 各一条线程:切后端显示各自历史", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  seedAnalysisCache(dir, "m1", { sessionId: "sid-a" });
  const chatRunner = vi.fn(async () => "答");
  let backend: "claudeCli" | "agy" = "claudeCli";
  const svc = createCoachChatService({
    getSettings: () => ({ ...settings(), aiBackend: backend }),
    matchesDir: dir,
    chatRunner: chatRunner as never,
  });
  await svc.send({ matchId: "m1", question: "问" });
  backend = "agy"; // agy 无分析 session → not-ready(线程也没有)
  expect((await svc.getState("m1")).status).toBe("not-ready");
  backend = "claudeCli";
  const st = (await svc.getState("m1")) as { messages: unknown[] };
  expect(st.messages).toHaveLength(2);
});
