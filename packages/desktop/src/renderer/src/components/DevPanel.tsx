import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StoredMatchMeta } from "../../../main/matchStore";
import type { DiagnosticEntry, LogsStatusSnapshot } from "../../../preload/api";
import { anonymizeMatchDoc } from "../../../shared/anonymizeFixture";
import {
  type DiagnosticLevel,
  diagnosticLevel,
} from "../../../shared/diagnosticLevel";
import { bridge } from "../bridge";
import {
  ancestorPaths,
  resolvePath,
  searchKeyPaths,
  stringifyNode,
} from "./dev/jsonNode";
import { JsonTree } from "./dev/JsonTree";

type DevZone = "watch" | "inspect" | "ai" | "diag";

const ZONE_LABEL: Record<DevZone, string> = {
  watch: "监控状态",
  inspect: "对局检查器",
  ai: "AI 调用",
  diag: "诊断",
};

interface AiCall {
  kind: "analysis" | "compare";
  matchId: string;
  at: number;
  model: string;
  prompt: string;
  raw: string;
}

interface RebuildState {
  running: boolean;
  i: number;
  n: number;
  done: { updated: number; failed: number } | null;
}

/** 桩件常缺面(见 desktop-dev skill),访问 bridge 一律兜底。 */
function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return fn().catch(() => fallback);
  } catch {
    return Promise.resolve(fallback);
  }
}
function safeSub(fn: () => () => void): () => void {
  try {
    return fn();
  } catch {
    return () => {};
  }
}

export function DevPanel({
  initialZone = "watch",
}: {
  /** 视觉回归场景直达某一区(与 App.initialAppView / MatchReport.initialView 同模式)。 */
  initialZone?: DevZone;
} = {}) {
  const [zone, setZone] = useState<DevZone>(initialZone);
  const [status, setStatus] = useState<LogsStatusSnapshot | null>(null);
  const [metas, setMetas] = useState<StoredMatchMeta[]>([]);
  const [diags, setDiags] = useState<DiagnosticEntry[]>([]);
  const [aiCalls, setAiCalls] = useState<AiCall[]>([]);
  const [wowDir, setWowDir] = useState<string | null>(null);

  useEffect(() => {
    void safe(() => bridge().logs.getStatus(), null).then(setStatus);
    void safe(() => bridge().matches.list(), []).then(setMetas);
    void safe(
      () => bridge().settings.get(),
      null as unknown as { wowDirectory: string | null },
    ).then((s) => setWowDir(s?.wowDirectory ?? null));
    void safe(() => bridge().debug.aiCalls(), [] as AiCall[]).then(setAiCalls);

    const unsubs = [
      safeSub(() => bridge().logs.onStatusChanged(setStatus)),
      safeSub(() =>
        bridge().logs.onMatchStored((m) => setMetas((prev) => [m, ...prev])),
      ),
      safeSub(() =>
        bridge().logs.onDiagnostic((d) =>
          setDiags((prev) => [d, ...prev].slice(0, 500)),
        ),
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  return (
    <div className="dev-wb">
      <DevRail
        zone={zone}
        setZone={setZone}
        aiCount={aiCalls.length}
        diagCount={diags.length}
      />
      <main className="dev-area">
        {zone === "watch" && (
          <WatchZone status={status} wowDir={wowDir} setWowDir={setWowDir} />
        )}
        {zone === "inspect" && <InspectZone metas={metas} />}
        {zone === "ai" && (
          <AiZone
            calls={aiCalls}
            refresh={() =>
              void safe(() => bridge().debug.aiCalls(), [] as AiCall[]).then(
                setAiCalls,
              )
            }
          />
        )}
        {zone === "diag" && (
          <DiagZone diags={diags} clear={() => setDiags([])} />
        )}
      </main>
      <StatusBar status={status} onClick={() => setZone("watch")} />
    </div>
  );
}

/* ────────────────────────── 导航 rail ────────────────────────── */

function DevRail({
  zone,
  setZone,
  aiCount,
  diagCount,
}: {
  zone: DevZone;
  setZone(z: DevZone): void;
  aiCount: number;
  diagCount: number;
}) {
  const badge: Partial<Record<DevZone, number>> = {
    ai: aiCount,
    diag: diagCount,
  };
  return (
    <nav
      className="dev-rail"
      data-testid="dev-rail"
      aria-label="开发者工具分区"
    >
      <ul>
        {(Object.keys(ZONE_LABEL) as DevZone[]).map((z) => (
          <li key={z}>
            <button
              type="button"
              data-testid={`dev-nav-${z}`}
              className={z === zone ? "active" : ""}
              aria-current={z === zone ? "page" : undefined}
              onClick={() => setZone(z)}
            >
              <span className="dev-nav-label">{ZONE_LABEL[z]}</span>
              {badge[z] ? <span className="dev-badge">{badge[z]}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <RebuildButton />
    </nav>
  );
}

/**
 * 全库重建。进度走 emit 频道行内显示 —— 旧实现跑完弹 alert,几分钟里
 * 界面既没反馈也不知道跑到哪了。
 */
function RebuildButton() {
  const [st, setSt] = useState<RebuildState>({
    running: false,
    i: 0,
    n: 0,
    done: null,
  });

  useEffect(
    () =>
      safeSub(() =>
        bridge().matches.onRebuildProgress((p) =>
          setSt((prev) => ({ ...prev, i: p.i, n: p.n })),
        ),
      ),
    [],
  );

  const run = () => {
    setSt({ running: true, i: 0, n: 0, done: null });
    void safe(() => bridge().matches.rebuildIndex(), {
      updated: 0,
      failed: 0,
    }).then((r) => setSt((prev) => ({ ...prev, running: false, done: r })));
  };

  return (
    <div className="dev-rail-foot">
      <button
        type="button"
        data-testid="dev-rebuild"
        disabled={st.running}
        onClick={run}
      >
        重建对局索引
      </button>
      {(st.running || st.done) && (
        <p className="dev-rebuild-progress" data-testid="dev-rebuild-progress">
          {st.running
            ? st.n > 0
              ? `${st.i}/${st.n}`
              : "准备中…"
            : `已更新 ${st.done!.updated},失败 ${st.done!.failed}`}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────── 底部状态条 ────────────────────────── */

function StatusBar({
  status,
  onClick,
}: {
  status: LogsStatusSnapshot | null;
  onClick(): void;
}) {
  const files = status?.files ?? [];
  const quarantined = files.some((f) => f.quarantined);
  // 「当前 tail 文件」= 最后一个未隔离的文件:worker 按文件名升序推进,
  // 末尾那个就是正在追的当日日志。
  const tail = [...files].reverse().find((f) => !f.quarantined) ?? files[0];

  return (
    <button
      type="button"
      className={`dev-statusbar${quarantined ? " warn" : ""}`}
      data-testid="dev-statusbar"
      onClick={onClick}
    >
      <span className="dev-sb-dot">
        {status?.watching ? "● watching" : "○ 未监控"}
      </span>
      {tail && (
        <>
          <span className="dev-sb-file">{tail.fileKey}</span>
          <span className="dev-sb-off">
            {tail.offset}/{tail.size}B
          </span>
        </>
      )}
      {quarantined && <span className="dev-sb-q">🧪 有隔离文件</span>}
    </button>
  );
}

/* ────────────────────────── 监控状态区 ────────────────────────── */

function WatchZone({
  status,
  wowDir,
  setWowDir,
}: {
  status: LogsStatusSnapshot | null;
  wowDir: string | null;
  setWowDir(d: string): void;
}) {
  const pick = async () => {
    const dir = await safe(() => bridge().app.selectDirectory(), null);
    if (dir) setWowDir(dir);
  };
  const files = status?.files ?? [];

  return (
    <section className="dev-zone" data-testid="dev-zone-watch">
      <h2>{ZONE_LABEL.watch}</h2>
      <div className="dev-kv">
        <span>WoW 目录</span>
        <span className="dev-mono">{wowDir ?? "未设置"}</span>
        <button type="button" onClick={() => void pick()}>
          选择目录…
        </button>
      </div>
      <div className="dev-kv">
        <span>监控</span>
        <span className="dev-mono">
          {status
            ? status.watching
              ? `✅ ${status.logsDir}`
              : `⛔ 未监控(${status.logsDir || "无目录"})`
            : "worker 未启动"}
        </span>
      </div>
      <table className="dev-table">
        <thead>
          <tr>
            <th>文件</th>
            <th>offset</th>
            <th>size</th>
            <th>进度</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.fileKey}>
              <td className="dev-mono">{f.fileKey}</td>
              <td className="dev-num">{f.offset}</td>
              <td className="dev-num">{f.size}</td>
              <td className="dev-num">
                {f.size > 0 ? `${Math.round((f.offset / f.size) * 100)}%` : "—"}
              </td>
              <td>{f.quarantined ? "🧪 quarantined" : ""}</td>
            </tr>
          ))}
          {files.length === 0 && (
            <tr>
              <td colSpan={5} className="rpt-dim">
                无监控中的文件
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="rpt-dim">
        AI 后端与模型在「设置」页配置(那里是单源,还含 DeepSeek
        等本页曾漏掉的后端)。
      </p>
    </section>
  );
}

/* ────────────────────────── 对局检查器 ────────────────────────── */

function matchHaystack(m: StoredMatchMeta): string {
  return [m.kind, m.bracket, m.zoneId, m.result, m.id]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function InspectZone({ metas }: { metas: StoredMatchMeta[] }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [nodePath, setNodePath] = useState("");
  const [nodeValue, setNodeValue] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly string[]>([]);
  const [autoExpand, setAutoExpand] = useState<readonly string[]>([]);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const reqId = useRef(0);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return metas;
    return metas.filter((m) => matchHaystack(m).includes(q));
  }, [metas, filter]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    setDetail(null);
    setNodePath("");
    setNodeValue(null);
    setHits([]);
    setAutoExpand([]);
    setSearchNote(null);
    const t0 = performance.now();
    void safe(() => bridge().matches.get(selected), null).then((d) => {
      if (reqId.current !== my) return; // 切场竞态:旧请求的结果直接丢
      setLoadMs(Math.round(performance.now() - t0));
      setDetail(d);
      setNodeValue(d);
      setLoading(false);
    });
  }, [selected]);

  const runSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      if (!q || detail == null) return;
      // 先当精确 key path 试(spec 的例子就是 rounds[5].deaths);
      // 解析不出来再退回有预算的键名搜索。
      const exact = resolvePath(detail, q);
      if (exact.ok) {
        setHits([q]);
        setAutoExpand([...ancestorPaths(q), q]);
        setSearchNote(null);
        return;
      }
      const r = searchKeyPaths(detail, q);
      setHits(r.paths);
      setAutoExpand(r.paths.flatMap((p) => [...ancestorPaths(p), p]));
      setSearchNote(
        r.paths.length === 0
          ? `无命中(已扫描 ${r.scanned} 个节点${r.truncated ? ",到达上限" : ""})`
          : r.truncated
            ? `命中 ${r.paths.length} 处(已扫描 ${r.scanned} 个节点到达上限,结果可能不全)`
            : `命中 ${r.paths.length} 处`,
      );
    },
    [query, detail],
  );

  const meta = metas.find((m) => m.id === selected) ?? null;

  const copyNode = async () => {
    try {
      await navigator.clipboard.writeText(stringifyNode(nodeValue));
      setAction("已复制当前节点");
    } catch {
      setAction("复制失败(剪贴板不可用)");
    }
  };

  const exportFixture = async () => {
    if (detail == null || !selected) return;
    setAction("脱敏中…");
    const { text, players } = anonymizeMatchDoc(detail);
    const saved = await safe(
      () =>
        bridge().app.saveTextFile({
          defaultName: `${selected}-fixture.json`,
          text,
        }),
      null,
    );
    setAction(saved ? `已导出(脱敏 ${players} 人):${saved}` : "已取消");
  };

  return (
    <section className="dev-zone dev-inspect" data-testid="dev-zone-inspect">
      <div className="dev-col dev-col-list" data-testid="dev-match-list">
        <input
          type="search"
          className="dev-input"
          data-testid="dev-match-filter"
          placeholder="筛选:kind / bracket / zone / result"
          aria-label="筛选对局"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="dev-match-rows">
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid="dev-match-row"
                className={m.id === selected ? "sel" : ""}
                onClick={() => setSelected(m.id)}
              >
                <span className="dev-mr-1">
                  [{m.kind}] {m.bracket} · zone {m.zoneId}
                </span>
                <span className="dev-mr-2">
                  {new Date(m.startTime).toLocaleString()} · {m.result}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="dev-match-count" data-testid="dev-match-count">
          {metas.length} 场 · 筛出 {filtered.length}
        </p>
      </div>

      <div className="dev-col dev-col-tree">
        <form
          className="dev-json-searchbar"
          data-testid="dev-json-search-form"
          onSubmit={runSearch}
        >
          <input
            type="search"
            className="dev-input"
            data-testid="dev-json-search"
            placeholder="key path(rounds[5].deaths)或键名"
            aria-label="搜索节点"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">搜索</button>
        </form>
        {searchNote && <p className="rpt-dim dev-search-note">{searchNote}</p>}
        {loading && <p className="rpt-dim">载入中…</p>}
        {!loading && detail == null && (
          <p className="rpt-dim">从左侧选一场对局</p>
        )}
        {!loading && detail != null && (
          <JsonTree
            root={detail}
            selectedPath={nodePath}
            onSelect={(p, v) => {
              setNodePath(p);
              setNodeValue(v);
            }}
            hits={hits}
            autoExpand={autoExpand}
          />
        )}
      </div>

      <div className="dev-col dev-col-actions">
        {selected ? (
          <div data-testid="dev-node-actions">
            <h3>{selected}</h3>
            <button
              type="button"
              data-testid="dev-open-dir"
              onClick={() => {
                void safe(() => bridge().matches.openDir(selected), false).then(
                  (ok) => setAction(ok ? "已打开目录" : "打开失败"),
                );
              }}
            >
              打开 matches/&lt;id&gt;/
            </button>
            <button
              type="button"
              data-testid="dev-copy-node"
              disabled={nodeValue == null && nodePath === ""}
              onClick={() => void copyNode()}
            >
              复制当前节点 JSON
            </button>
            <button
              type="button"
              data-testid="dev-reparse"
              onClick={() => {
                setAction("重新解析中…");
                void safe(() => bridge().matches.reparse(selected), {
                  ok: false,
                }).then((r) =>
                  setAction(r.ok ? "已重新解析并回填 meta" : "重新解析失败"),
                );
              }}
            >
              重新解析此对局
            </button>
            <button
              type="button"
              data-testid="dev-export-fixture"
              disabled={detail == null}
              onClick={() => void exportFixture()}
            >
              导出脱敏 fixture
            </button>
            {action && (
              <p
                className="rpt-dim dev-action-note"
                data-testid="dev-action-note"
              >
                {action}
              </p>
            )}
            <DocFacts
              meta={meta}
              detail={detail}
              loadMs={loadMs}
              nodePath={nodePath}
            />
          </div>
        ) : (
          <p className="rpt-dim">未选中对局</p>
        )}
      </div>
    </section>
  );
}

/**
 * 右栏底部小卡。只放**不用遍历文档就能拿到**的事实 —— 事件总数之类要全图
 * walk 才知道,那正是本次改版要避免的长任务。
 */
function DocFacts({
  meta,
  detail,
  loadMs,
  nodePath,
}: {
  meta: StoredMatchMeta | null;
  detail: unknown;
  loadMs: number | null;
  nodePath: string;
}) {
  const facts = useMemo(() => {
    const d = (detail ?? {}) as Record<string, unknown>;
    // 落盘形状是 {schemaVersion, kind, data};shuffle 的字段在 data.rounds[0]。
    // 取法与 matchStore.rebuiltMeta 一致 —— 同一个「这场比赛的事实在哪」
    // 不该有两套读法。
    const inner = (d["data"] ?? d) as Record<string, unknown>;
    const rounds = inner["rounds"];
    const src =
      Array.isArray(rounds) && rounds.length > 0
        ? ((rounds as Record<string, unknown>[])[0] ?? {})
        : inner;
    return {
      topKeys: detail == null ? 0 : Object.keys(d).length,
      linesTotal: src["linesTotal"],
      linesDropped: src["linesDropped"],
      advanced: src["hasAdvancedLogging"],
    };
  }, [detail]);

  return (
    <dl className="dev-facts" data-testid="dev-doc-facts">
      <dt>载入耗时</dt>
      <dd>{loadMs == null ? "—" : `${loadMs}ms`}</dd>
      <dt>顶层键</dt>
      <dd>{facts.topKeys}</dd>
      <dt>日志行(总/丢弃)</dt>
      <dd>
        {String(facts.linesTotal ?? "—")}/{String(facts.linesDropped ?? "—")}
      </dd>
      <dt>高级日志</dt>
      <dd>{facts.advanced === undefined ? "—" : String(facts.advanced)}</dd>
      <dt>时长</dt>
      <dd>{meta?.durationS == null ? "—" : `${meta.durationS}s`}</dd>
      <dt>当前节点</dt>
      <dd className="dev-mono">{nodePath || "(根)"}</dd>
    </dl>
  );
}

/* ────────────────────────── AI 调用区 ────────────────────────── */

function AiZone({ calls, refresh }: { calls: AiCall[]; refresh(): void }) {
  const [open, setOpen] = useState<number | null>(null);
  const copy = (text: string) => {
    try {
      void navigator.clipboard.writeText(text);
    } catch {
      /* 剪贴板不可用时静默 —— 这是调试辅助,不该打断 */
    }
  };
  return (
    <section className="dev-zone" data-testid="dev-zone-ai">
      <h2>
        {ZONE_LABEL.ai}({calls.length}){" "}
        <button type="button" onClick={refresh}>
          刷新
        </button>
      </h2>
      {calls.length === 0 && (
        <p className="rpt-dim">
          无记录 —— 跑一次 AI 分析/对比后点「刷新」。仅保留最近 10
          次,存内存不落盘。
        </p>
      )}
      <ul className="dev-ai-rows" data-testid="dev-ai-list">
        {calls.map((c, i) => (
          <li key={i} data-testid="dev-ai-row">
            <div className="dev-ai-head">
              <span className="dev-ai-t">
                {new Date(c.at).toLocaleTimeString()}
              </span>
              <span className="dev-ai-kind">[{c.kind}]</span>
              <span className="dev-mono">{c.matchId}</span>
              <span className="dev-ai-model">{c.model}</span>
              <span className="dev-ai-size">
                prompt {c.prompt.length} 字 → 返回 {c.raw.length} 字
              </span>
              <span className="dev-ai-ops">
                <button
                  type="button"
                  onClick={() => setOpen(open === i ? null : i)}
                >
                  {open === i ? "收起" : "查看"}
                </button>
                <button type="button" onClick={() => copy(c.prompt)}>
                  复制 prompt
                </button>
                <button type="button" onClick={() => copy(c.raw)}>
                  复制返回
                </button>
              </span>
            </div>
            {open === i && (
              <div className="dev-ai-body">
                <h4>Prompt</h4>
                <pre>{c.prompt}</pre>
                <h4>返回文本</h4>
                <pre>{c.raw}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ────────────────────────── 诊断区 ────────────────────────── */

const LEVEL_FILTERS: Array<{ key: "all" | DiagnosticLevel; label: string }> = [
  { key: "all", label: "全部" },
  { key: "warn", label: "warn" },
  { key: "error", label: "error" },
];

function DiagZone({
  diags,
  clear,
}: {
  diags: DiagnosticEntry[];
  clear(): void;
}) {
  const [level, setLevel] = useState<"all" | DiagnosticLevel>("all");
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => {
    const q = text.trim().toLowerCase();
    return diags.filter((d) => {
      if (level !== "all" && diagnosticLevel(d.code) !== level) return false;
      if (!q) return true;
      return `${d.code} ${d.fileKey ?? ""} ${d.detail ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [diags, level, text]);

  useEffect(() => {
    if (paused || !listRef.current) return;
    // 新行插在最前(倒序),回到顶部即「跟随最新」。用 scrollTop 而不是
    // scrollTo:后者在 jsdom 里不存在,会把组件测试整片打红。
    listRef.current.scrollTop = 0;
  }, [rows, paused]);

  const counts = useMemo(() => {
    let warn = 0;
    let error = 0;
    for (const d of diags) {
      if (diagnosticLevel(d.code) === "warn") warn++;
      else error++;
    }
    return { all: diags.length, warn, error };
  }, [diags]);

  return (
    <section className="dev-zone dev-diag" data-testid="dev-zone-diag">
      <h2>{ZONE_LABEL.diag}</h2>
      <div className="dev-diag-bar">
        {LEVEL_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid={`dev-diag-level-${f.key}`}
            className={level === f.key ? "active" : ""}
            aria-pressed={level === f.key}
            onClick={() => setLevel(f.key)}
          >
            {f.label} {counts[f.key]}
          </button>
        ))}
        <input
          type="search"
          className="dev-input"
          data-testid="dev-diag-filter"
          placeholder="过滤 code / 文件 / 详情"
          aria-label="过滤诊断"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          data-testid="dev-diag-pause"
          aria-pressed={paused}
          className={paused ? "active" : ""}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "▶ 继续" : "⏸ 暂停"}
        </button>
        <button type="button" data-testid="dev-diag-clear" onClick={clear}>
          清空
        </button>
      </div>
      <ul className="dev-diag-rows" data-testid="dev-diag-list" ref={listRef}>
        {rows.map((d, i) => {
          const lv = diagnosticLevel(d.code);
          return (
            <li key={i} data-testid="dev-diag-row" className={`lv-${lv}`}>
              <span className="dev-diag-t">
                {new Date(d.at).toLocaleTimeString()}
              </span>
              <span className={`dev-diag-lv lv-${lv}`}>{lv}</span>
              <span className="dev-diag-code">{d.code}</span>
              <span className="dev-mono">{d.fileKey ?? ""}</span>
              {/* spec 提到的 PARSE_FAIL 上下文动作没有做:全仓查下来实际
                  会发出的 code 只有 BUILD_FAILED / LOGS_DIR_UNREADABLE 与
                  parser 的不变量 code,没有 PARSE_FAIL —— 写了也是一条永不
                  执行的分支。等真有这个 code 再补。 */}
              <span className="dev-diag-detail">{d.detail ?? ""}</span>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="rpt-dim">
            无诊断{diags.length > 0 ? "(被筛掉了)" : ""}
          </li>
        )}
      </ul>
    </section>
  );
}
