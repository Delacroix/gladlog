import { ensureAnalysisData } from "@gladlog/analysis";
import { useEffect, useRef, useState } from "react";

import { bridge } from "../../bridge";
import { buildAnalysisInput } from "../derive/analysisInput";
import type { ReportSource } from "../derive/types";

type ChatMessage = { role: "user" | "assistant"; content: string; at: number };
type ChatState =
  | { status: "unsupported" }
  | { status: "not-ready" }
  | {
      status: "ready";
      backend: string;
      model: string;
      messages: ChatMessage[];
      busy: boolean;
    };

/**
 * 教练追问卡(spec 2026-08-02):AI 视图挂载,基于本轮分析 session 继续对话。
 * 四态状态机——unsupported(非 CLI 后端)/ not-ready(尚无可续会话)/
 * ready(消息列表 + 输入框)。桩纪律:bridge().chat 面缺失时卡片渲染
 * null(不炸整个 AI 视图)。
 */
export function CoachChatCard({
  source,
  matchId,
}: {
  source: ReportSource;
  matchId: string;
}) {
  const [chatState, setChatState] = useState<ChatState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [available, setAvailable] = useState(true);
  // 乐观回显:send 成功即本地追加一对消息,而非死等 refresh() 拿到持久化
  // 结果——真实后端 refresh 会把这对消息带回来。
  // 生命周期修复(终审 F5):清空不做「角色+文本内容」逐条匹配——那套设计
  // 对重复提问不安全:用户把同一句话问两遍时,第二次的乐观气泡会被第一次
  // 已持久化的同文本消息误判成「已到达」而提前摘掉,导致气泡早退。改为
  // 按发送轮次整体清空:doSend 拿到 { status: "ok" } 后才追加这一轮的乐观
  // 条目并调用 refresh(),refresh() 返回时 server 状态已经包含它们,doSend
  // 就地把这一轮加的条目整体清空(见下方 doSend)。refresh() 本身不再碰
  // optimistic —— 它同时服务 mount/matchId 切换/analysis:onDone 三个调用点,
  // 这些场景下 optimistic 本就应为空,不该由通用刷新函数猜哪些条目"已到达"。
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const s = await bridge().chat.getState(matchId);
      setChatState(s);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }

  useEffect(() => {
    // 切场状态泄漏修复(终审 F4):matchId 变化时,上一场遗留的乐观气泡/
    // 在飞标记/失败标记/未发出草稿都属于上一场对话,必须清空——否则
    // match1 的失败/pending/乐观气泡会渲染进 match2 的聊天卡里。
    setOptimistic([]);
    setPending(null);
    setFailed(null);
    setDraft("");
    void refresh();
    let off: (() => void) | undefined;
    try {
      off = bridge().analysis?.onDone?.(() => void refresh());
    } catch {
      /* 面缺失时静默——降级为 mount/matchId 变化刷新 */
    }
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchId]);

  useEffect(() => {
    if (msgsRef.current)
      msgsRef.current.scrollTop = msgsRef.current.scrollHeight;
  }, [chatState, pending]);

  if (!available) return null;
  if (!chatState) return null;

  async function doSend(question: string) {
    setPending(question);
    setFailed(null);
    // 在飞草稿被抹修复(终审 F6a):清空移到发送起点,而不是等成功响应
    // 回来才清——`question` 这个局部参数已经把要发的文本捕获住了,后面
    // 全程用它,不再依赖 draft 状态存活;这样飞行期间用户继续在输入框里
    // 敲的新草稿就不会被"发送成功"事后覆盖清空。
    setDraft("");
    try {
      let r = await bridge().chat.send({ matchId, question });
      if (r.status === "need-reseed") {
        await ensureAnalysisData();
        const input = buildAnalysisInput(source, matchId);
        const cached = (await bridge().analysis.getCached(matchId)) as {
          findings?: Array<{ title: string; explanation?: string }>;
        } | null;
        const findingsSummary =
          (cached?.findings ?? [])
            .map((f, i) => `${i + 1}. ${f.title} — ${f.explanation ?? ""}`)
            .join("\n") || "(none)";
        if (!input) {
          setFailed(question);
          setPending(null);
          return;
        }
        r = await bridge().chat.send({
          matchId,
          question,
          seed: {
            richContext: input.richContext,
            spec: input.spec,
            ownerName: input.ownerName,
            findingsSummary,
          },
        });
      }
      if (r.status === "ok") {
        const now = Date.now();
        setOptimistic((prev) => [
          ...prev,
          { role: "user", content: question, at: now },
          { role: "assistant", content: r.reply, at: now },
        ]);
        await refresh();
        // 乐观回显生命周期(终审 F5):这一轮的乐观条目到这里整体清空——
        // refresh() 拿到的 server 状态此时已经包含它们,不做内容匹配。
        setOptimistic([]);
      } else if (r.status === "error" && r.message === "已停止") {
        // 取消误标失败修复(终审 F6b):用户按「停止」是中性操作,不是
        // 失败——不进 failed+重试 UI,丢弃这条 pending 气泡,把问题文本
        // 还给输入框让用户直接编辑/重发。
        setDraft(question);
      } else {
        setFailed(question);
      }
    } catch {
      setFailed(question);
    }
    setPending(null);
  }

  if (chatState.status === "unsupported") {
    return (
      <div className="coach-chat-card" data-testid="coach-chat-card">
        <div className="coach-chat-empty">对话教练需要本地 CLI 后端</div>
      </div>
    );
  }
  if (chatState.status === "not-ready") {
    return (
      <div className="coach-chat-card" data-testid="coach-chat-card">
        <div className="coach-chat-empty">开始 AI 分析后才能对话</div>
      </div>
    );
  }

  return (
    <div className="coach-chat-card" data-testid="coach-chat-card">
      <div className="coach-chat-head">
        {chatState.backend} · {chatState.model}
      </div>
      <div className="coach-chat-msgs" ref={msgsRef} tabIndex={0}>
        {[...chatState.messages, ...optimistic].map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "coach-chat-msg coach-chat-msg--user"
                : "coach-chat-msg coach-chat-msg--coach"
            }
          >
            {m.content}
          </div>
        ))}
        {pending && (
          <div className="coach-chat-msg coach-chat-msg--user">{pending}</div>
        )}
        {pending && (
          <div className="coach-chat-msg coach-chat-msg--coach coach-chat-thinking">
            教练思考中…
          </div>
        )}
        {failed && (
          <div className="coach-chat-msg coach-chat-msg--user coach-chat-failed">
            {failed}
            <span className="coach-chat-fail-text">发送失败 · </span>
            <button
              className="coach-chat-retry"
              onClick={() => void doSend(failed)}
            >
              重试
            </button>
          </div>
        )}
      </div>
      <div className="coach-chat-input-row">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="问教练…"
        />
        {pending ? (
          <button onClick={() => void bridge().chat.cancel(matchId)}>
            停止
          </button>
        ) : (
          <button
            disabled={!draft.trim()}
            onClick={() => {
              const q = draft.trim();
              if (q) void doSend(q);
            }}
          >
            发送
          </button>
        )}
      </div>
      <div className="coach-chat-disclaimer">回答基于日志推理,可能有误</div>
    </div>
  );
}
