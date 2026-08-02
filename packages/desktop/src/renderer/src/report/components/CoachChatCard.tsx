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
    // 切场状态泄漏修复(终审 F4):matchId 变化时,上一场遗留的在飞标记/
    // 失败标记/未发出草稿都属于上一场对话,必须清空——否则 match1 的
    // 失败/pending 会渲染进 match2 的聊天卡里。
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

  /**
   * `fromDraft`(终审 B1):是否是「从当前草稿框发送」这次调用——只有这个
   * 入口允许触碰 draft 状态。重试按钮传 false:它发的是 `failed` 里捕获
   * 的旧文本,不是当前草稿;旧实现在 doSend 顶部无条件 `setDraft("")`,
   * 用户在失败气泡挂着时打的新问题会被点「重试」瞬间抹掉——F6a 要修的
   * 同类缺陷经重试入口重开了一次,这次把「清草稿」限定在真正拥有草稿的
   * 调用点。
   */
  async function doSend(question: string, fromDraft: boolean) {
    setPending(question);
    setFailed(null);
    // 在飞草稿被抹修复(终审 F6a):清空移到发送起点,而不是等成功响应
    // 回来才清——`question` 这个局部参数已经把要发的文本捕获住了,后面
    // 全程用它,不再依赖 draft 状态存活;这样飞行期间用户继续在输入框里
    // 敲的新草稿就不会被"发送成功"事后覆盖清空。仅当这次是从草稿发出的
    // (fromDraft)才清——见上方注释。
    if (fromDraft) setDraft("");
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
        // 乐观回显生命周期(终审 F5,第二轮 B2 修复):不再单独维护一份
        // optimistic 数组——那套设计假设只有 doSend 自己这次 refresh()
        // 会拉到刚持久化的这一轮,但 analysis:onDone 监听(见上方 effect)
        // 同样会触发 refresh();如果落在 setOptimistic(add) 与
        // setOptimistic([]) 之间,server messages 已经含这一轮而
        // optimistic 还没清,`[...messages, ...optimistic]` 会闪一帧重复
        // 气泡。改法:压根不进 optimistic,让 pending(问题气泡 + 「教练
        // 思考中」)一直挂到自己这次 refresh() 完成才清(下面 finally 前
        // 的 setPending(null))——这样任何并发 refresh() 落地都只是提前
        // 把 chatState 刷新好,不会跟一个独立维护的乐观数组打架。
        await refresh();
      } else if (r.status === "error" && r.message === "已停止") {
        // 取消误标失败修复(终审 F6b):用户按「停止」是中性操作,不是
        // 失败——不进 failed+重试 UI,丢弃这条 pending 气泡。从草稿发出的
        // 把问题文本还给输入框让用户直接编辑/重发;从「重试」发起的
        // (终审 B1)不碰 draft——那是另一条消息的草稿,退回失败态让用户
        // 再按一次「重试」。
        if (fromDraft) setDraft(question);
        else setFailed(question);
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
        {chatState.messages.map((m, i) => (
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
              onClick={() => void doSend(failed, false)}
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
              if (q) void doSend(q, true);
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
