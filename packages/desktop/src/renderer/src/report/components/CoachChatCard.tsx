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
  // 结果——真实后端 refresh 会把这对消息带回来。去重按「角色+文本内容」逐条
  // 匹配持久化列表(而不是比较数组长度):长度型启发式对「单条合并回合」
  // /「上下文裁剪导致长度不增」这类真实后端行为不稳(审查发现:会漏判导致
  // 重复气泡或误判导致刚发的消息在真实结果到达前先消失)。内容匹配对增长
  // 形态不敏感,只要持久化列表里出现了同角色+同文本的条目就摘掉对应的乐观
  // 条目,其余乐观条目原样保留直到匹配上或用户离开当前会话。
  const [optimistic, setOptimistic] = useState<ChatMessage[]>([]);
  const msgsRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      const s = await bridge().chat.getState(matchId);
      if (s.status === "ready") {
        setOptimistic((prev) =>
          prev.filter(
            (o) =>
              !s.messages.some(
                (m) => m.role === o.role && m.content === o.content,
              ),
          ),
        );
      }
      setChatState(s);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }

  useEffect(() => {
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
        setDraft("");
        const now = Date.now();
        setOptimistic((prev) => [
          ...prev,
          { role: "user", content: question, at: now },
          { role: "assistant", content: r.reply, at: now },
        ]);
        await refresh();
      } else setFailed(question);
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
