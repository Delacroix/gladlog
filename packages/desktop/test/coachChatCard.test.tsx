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
