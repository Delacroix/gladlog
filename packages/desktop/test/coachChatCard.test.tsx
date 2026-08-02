// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { CoachChatCard } from "../src/renderer/src/report/components/CoachChatCard";

const src = { units: {} } as never;

function stubChat(state: unknown, send?: (input: unknown) => Promise<unknown>) {
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => state,
      send: send ?? (async () => ({ status: "ok", reply: "答" })),
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
}

it("unsupported:显示 CLI 引导文案,无输入框", async () => {
  stubChat({ status: "unsupported" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/需要本地 CLI 后端/);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("not-ready:显示「开始 AI 分析后才能对话」", async () => {
  stubChat({ status: "not-ready" });
  render(<CoachChatCard source={src} matchId="m1" />);
  await screen.findByText(/开始 AI 分析后才能对话/);
});

it("ready:发消息 → 显示用户消息与教练回复", async () => {
  stubChat({
    status: "ready",
    backend: "claudeCli",
    model: "sonnet",
    messages: [],
    busy: false,
  });
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("答");
  expect(screen.getByText("为什么?")).toBeTruthy();
});

it("ready:真实后端持久化消息追上后,乐观回显按内容去重、不产生重复气泡", async () => {
  let messages: Array<{
    role: "user" | "assistant";
    content: string;
    at: number;
  }> = [];
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => ({
        status: "ready",
        backend: "claudeCli",
        model: "sonnet",
        messages,
        busy: false,
      }),
      // 模拟真实后端:send 成功即把这一轮持久化进 messages(而非测试桩里
      // 固定不变的空数组)——审查发现原有的「长度增长」去重启发式从未被
      // 这种真实场景练到过。
      send: async (input: { question: string }) => {
        messages = [
          ...messages,
          { role: "user" as const, content: input.question, at: Date.now() },
          { role: "assistant" as const, content: "答复", at: Date.now() },
        ];
        return { status: "ok", reply: "答复" };
      },
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("答复");
  expect(screen.getAllByText("答复")).toHaveLength(1);
  expect(screen.getAllByText("为什么?")).toHaveLength(1);
});

it("发送失败(error):该条标失败并给重试按钮", async () => {
  stubChat(
    {
      status: "ready",
      backend: "claudeCli",
      model: "sonnet",
      messages: [],
      busy: false,
    },
    async () => ({ status: "error", message: "boom" }),
  );
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "问" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText(/发送失败/);
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});
