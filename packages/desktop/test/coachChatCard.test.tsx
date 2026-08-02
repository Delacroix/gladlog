// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { CoachChatCard } from "../src/renderer/src/report/components/CoachChatCard";

const src = { units: {} } as never;

function stubChat(state: unknown, send?: (input: unknown) => Promise<unknown>) {
  // 默认 send(未传自定义 send 时):真实后端 send() 落盘持久化在先、才
  // resolve——CoachChatCard 的成功路径靠自己那次 refresh() 拿到已持久化的
  // 消息才清 pending(终审 F5/B2),就地把新消息塞进传入的 state.messages
  // (同一个对象引用),让后续 getState() 调用能读到,而不是像旧桩那样
  // 永远返回不变的空数组。
  const defaultSend = async (input: unknown) => {
    const s = state as { status: string; messages?: unknown[] };
    if (s.status === "ready" && Array.isArray(s.messages)) {
      const q = (input as { question: string }).question;
      s.messages = [
        ...s.messages,
        { role: "user", content: q, at: Date.now() },
        { role: "assistant", content: "答", at: Date.now() },
      ];
    }
    return { status: "ok", reply: "答" };
  };
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => state,
      send: send ?? defaultSend,
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

it("ready:真实后端持久化消息追上后展示,不产生重复气泡", async () => {
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
      // 固定不变的空数组)。
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

it("ready:重复提问不被误杀(终审 F5/B2:成功路径不进 optimistic,pending 挂到自己这次 refresh() 完成才清,不做角色+内容匹配)", async () => {
  let messages: Array<{
    role: "user" | "assistant";
    content: string;
    at: number;
  }> = [];
  let replyCount = 0;
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => ({
        status: "ready",
        backend: "claudeCli",
        model: "sonnet",
        messages,
        busy: false,
      }),
      // 每次 send 成功都把这一轮持久化进 messages —— 模拟真实后端会话增长。
      send: async (input: { question: string }) => {
        replyCount += 1;
        const reply = `答复${replyCount}`;
        messages = [
          ...messages,
          { role: "user" as const, content: input.question, at: Date.now() },
          { role: "assistant" as const, content: reply, at: Date.now() },
        ];
        return { status: "ok", reply };
      },
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");

  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("答复1");

  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText("答复2");

  // 旧的「角色+文本内容」去重会把第二次的「为什么?」误判成第一次已持久化
  // 的同文本消息「已到达」而提前摘掉气泡;现在成功路径压根不进一份独立
  // 维护的乐观数组,展示的就是 chatState.messages 本身,不做内容匹配,
  // 两条用户提问都应该在。
  expect(screen.getAllByText("为什么?")).toHaveLength(2);
  expect(screen.getAllByText("答复1")).toHaveLength(1);
  expect(screen.getAllByText("答复2")).toHaveLength(1);
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

it("重试不清空无关在飞草稿(终审 B1):失败态下草稿有内容 → 点重试 → 草稿保留", async () => {
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
  fireEvent.change(input, { target: { value: "第一条问题" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText(/发送失败/);
  // 失败气泡挂着的时候,用户打了一段和这次重试完全无关的新草稿。
  fireEvent.change(input, { target: { value: "无关的新草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  // 重试发的是 failed 里捕获的旧文本,不是当前草稿——不该碰 draft(旧
  // 实现在 doSend 顶部无条件 setDraft("") 会把这段新草稿瞬间抹掉)。
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "无关的新草稿",
  );
  // 重试同样会失败,收尾等它跑完,不留悬空 promise/act 警告。
  await screen.findByText(/发送失败/);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "无关的新草稿",
  );
});

it("取消视为中性操作,不进失败态(终审 F6b):停止后不显示发送失败,问题文本还给草稿", async () => {
  stubChat(
    {
      status: "ready",
      backend: "claudeCli",
      model: "sonnet",
      messages: [],
      busy: false,
    },
    async () => ({ status: "error", message: "已停止" }),
  );
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "问题A" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  // pending 结束、按钮变回「发送」——doSend 的 catch/else 分支已经跑完。
  await screen.findByRole("button", { name: "发送" });
  expect(screen.queryByText(/发送失败/)).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "问题A",
  );
});

it("在飞草稿不被抹(终审 F6a):发送成功后不清空用户飞行期间新打的字", async () => {
  let messages: Array<{
    role: "user" | "assistant";
    content: string;
    at: number;
  }> = [];
  let releaseSend!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  (window as never as { __gladlogFixture: unknown }).__gladlogFixture = {
    chat: {
      getState: async () => ({
        status: "ready",
        backend: "claudeCli",
        model: "sonnet",
        messages,
        busy: false,
      }),
      // 卡在 gate 上直到测试放行,模拟"飞行中";真实后端 send() 落盘持久化
      // 在先、才 resolve,所以 resolve 之后 messages 已经包含这一轮。
      send: async (input: { question: string }) => {
        await gate;
        messages = [
          ...messages,
          { role: "user" as const, content: input.question, at: Date.now() },
          { role: "assistant" as const, content: "答", at: Date.now() },
        ];
        return { status: "ok", reply: "答" };
      },
      cancel: async () => {},
    },
    analysis: { getCached: async () => ({ findings: [] }) },
  };
  render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "第一条问题" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  // 发送起点即清空草稿(F6a)——pending 气泡里应该看到原问题文本。
  await screen.findByText("第一条问题");
  // 飞行期间用户继续打字。
  fireEvent.change(input, { target: { value: "还没发的新草稿" } });
  releaseSend();
  await screen.findByText("答");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "还没发的新草稿",
  );
});

it("切场清状态(终审 F4):match1 的失败标记/草稿不带进 match2", async () => {
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
  const { rerender } = render(<CoachChatCard source={src} matchId="m1" />);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "为什么?" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText(/发送失败/);
  // 失败之后又打了一段还没发出去的新草稿。
  fireEvent.change(input, { target: { value: "还没发的新草稿" } });

  rerender(<CoachChatCard source={src} matchId="m2" />);
  await screen.findByRole("textbox"); // m2 同样是 ready 态,输入框还在
  expect(screen.queryByText(/发送失败/)).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});
