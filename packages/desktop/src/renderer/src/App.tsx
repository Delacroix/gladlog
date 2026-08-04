import { useEffect, useMemo, useState } from "react";
import { BatchAnalyzeBar } from "./components/BatchAnalyzeBar";
import { DevPanel } from "./components/DevPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatsDashboard } from "./components/StatsDashboard";
import { UpdateBanner } from "./components/UpdateBanner";
import { deriveRatingDeltas } from "./components/dashboard";
import { ImportButton } from "./components/ImportButton";
import { MatchListRow } from "./components/MatchListRow";
import {
  applyFilter,
  EMPTY_FILTER,
  MatchListFilter,
  type ListFilter,
} from "./components/MatchListFilter";
import { MatchReport } from "./report/components/MatchReport";
import { ShuffleReport } from "./report/components/ShuffleReport";
import type { StoredMatchMeta } from "../../main/matchStore";
import { bridge } from "./bridge";
import { startAutoAnalyzeListener } from "./batch/autoAnalyze";

type AppView = "matches" | "stats" | "settings" | "dev";
const APP_VIEW_LABEL: Record<AppView, string> = {
  matches: "对局",
  stats: "战绩",
  settings: "设置",
  dev: "开发者",
};

export default function App({
  initialAppView = "matches",
  initialDevZone,
}: {
  initialAppView?: AppView;
  /** For visual-regression scenes: jump straight to one zone of the dev page. */
  initialDevZone?: "watch" | "inspect" | "ai" | "diag";
} = {}) {
  const [appView, setAppView] = useState<AppView>(initialAppView);
  const [metas, setMetas] = useState<StoredMatchMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<any | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  // Batch-selection checkmarks (meta ids; a shuffle id selects the whole
  // lobby). Lives here because both the batch bar (launch/clear) and every
  // list row (toggle) read it.
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [wowDir, setWowDir] = useState<string | null>(null);

  useEffect(() => {
    // The test stub may not have a settings surface
    try {
      void bridge()
        .settings.get()
        .then((s) => setWowDir(s.wowDirectory))
        .catch(() => {});
    } catch {
      /* noop */
    }
  }, []);

  useEffect(() => {
    // Auto-analyze new matches (2026-08-01): subscribe on mount, unsubscribe on
    // unmount. When the stub lacks a logs surface, the bridge().logs.onMatchStored
    // call inside startAutoAnalyzeListener throws outright (same try/catch
    // precedent as the settings stub for wowDir above).
    try {
      return startAutoAnalyzeListener();
    } catch {
      return undefined;
    }
  }, []);
  const PAGE = 100;

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Background backfill (backlog #12) is the only pagination driver: the first
    // page renders immediately, then idle time pulls the whole meta index page by
    // page (meta rows are tiny, so keeping them all resident is affordable). It
    // does not coexist with scroll-triggered loading — two drivers trip over each
    // other on hasMore and the cursor (agy review, item 1).
    void (async () => {
      const first = await bridge().matches.page({ limit: PAGE });
      if (cancelled) return;
      setMetas(first);
      setHasMore(first.length === PAGE);
      // Show the most recent match right at startup, sparing a click out of the empty state
      setSelectedId((cur) => cur ?? first[0]?.id ?? null);
      let cursor = first[first.length - 1]?.startTime;
      let more = first.length === PAGE;
      while (more && !cancelled && cursor !== undefined) {
        await sleep(150); // yield between pages to user interaction and other IPC
        if (cancelled) return;
        const older = await bridge().matches.page({
          before: cursor,
          limit: PAGE,
        });
        if (cancelled) return;
        setMetas((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const fresh = older.filter((m) => !seen.has(m.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        const next = older[older.length - 1]?.startTime;
        // The cursor must strictly decrease, otherwise stop (so bad data cannot
        // pin the loop to the same page forever)
        more = older.length === PAGE && next !== undefined && next < cursor;
        cursor = next;
        if (!more) setHasMore(false);
      }
    })();
    // Insert stored-match notifications in time order: a history import floods in
    // old matches, and a bare prepend would break the list's newest→oldest
    // ordering (agy review, item 2).
    let unMatchStored: (() => void) | undefined;
    try {
      unMatchStored = bridge().logs.onMatchStored((m) =>
        setMetas((prev) =>
          prev.some((p) => p.id === m.id)
            ? prev
            : [...prev, m].sort((a, b) => b.startTime - a.startTime),
        ),
      );
    } catch {
      /* the test stub has no logs surface */
    }
    return () => {
      cancelled = true;
      unMatchStored?.();
    };
  }, []);

  useEffect(() => {
    if (selectedId) {
      void bridge().matches.get(selectedId).then(setDoc);
    } else {
      setDoc(null);
    }
  }, [selectedId]);

  // Rating deltas (1e): the algorithm lives in dashboard.ts's deriveRatingDeltas
  // (single-source, shared with the stats page's "recent matches" card)
  const ratingDeltas = useMemo(() => deriveRatingDeltas(metas), [metas]);

  // Date grouping (1e): today / yesterday / month-day, plus a per-day summary of
  // "N matches · W-L"
  const grouped = useMemo(() => {
    const list = applyFilter(metas, filter);
    const groups: Array<{
      key: string;
      label: string;
      summary: string;
      items: StoredMatchMeta[];
    }> = [];
    const today = new Date();
    const dayLabel = (d: Date): string => {
      const sameDay = (a: Date, b: Date) =>
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
      const yesterday = new Date(today.getTime() - 86_400_000);
      if (sameDay(d, today)) return "今天";
      if (sameDay(d, yesterday)) return "昨天";
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    };
    for (const m of list) {
      const d = new Date(m.startTime);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const cur = groups[groups.length - 1];
      if (cur && cur.key === key) cur.items.push(m);
      else groups.push({ key, label: dayLabel(d), summary: "", items: [m] });
    }
    for (const g of groups) {
      const wins = g.items.filter((m) =>
        m.result.toLowerCase().startsWith("win"),
      ).length;
      g.summary = `${g.items.length} 场 · ${wins}-${g.items.length - wins}`;
    }
    return groups;
  }, [metas, filter]);

  return (
    <div className="app-container">
      <header className="app-topbar">
        <h1>gladlog</h1>
        <div className="rpt-view-tabs app-view-tabs">
          {(Object.keys(APP_VIEW_LABEL) as AppView[]).map((v) => (
            <button
              key={v}
              className={v === appView ? "active" : ""}
              onClick={() => setAppView(v)}
            >
              {APP_VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        <UpdateBanner />
      </header>
      {appView === "dev" ? (
        <DevPanel initialZone={initialDevZone} />
      ) : appView === "settings" ? (
        <SettingsPanel />
      ) : appView === "stats" ? (
        <StatsDashboard
          onCompClick={(specId) => {
            setFilter({ ...EMPTY_FILTER, specIds: [specId] });
            setAppView("matches");
          }}
          onZoneClick={(zoneId) => {
            setFilter({ ...EMPTY_FILTER, zoneId });
            setAppView("matches");
          }}
          onOpenMatch={(matchId) => {
            setSelectedId(matchId);
            setAppView("matches");
          }}
        />
      ) : (
        <div className="app-layout">
          <aside className="app-sidebar">
            <BatchAnalyzeBar
              metas={metas}
              selected={batchSelected}
              onClearSelected={() => setBatchSelected(new Set())}
            />
            <MatchListFilter
              metas={metas}
              filter={filter}
              onChange={setFilter}
            />
            <ul data-testid="match-list" className="match-list">
              {grouped.flatMap((g) => [
                <li key={`g:${g.key}`} className="mlr-group">
                  <span>{g.label}</span>
                  <span className="mlr-group-sum">{g.summary}</span>
                </li>,
                ...g.items.map((m) => (
                  <li
                    key={m.id}
                    className={m.id === selectedId ? "sel" : ""}
                    onClick={() => setSelectedId(m.id)}
                  >
                    <MatchListRow
                      meta={m}
                      ratingDelta={ratingDeltas.get(m.id)}
                      checked={batchSelected.has(m.id)}
                      onToggleCheck={() =>
                        setBatchSelected((cur) => {
                          const next = new Set(cur);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        })
                      }
                    />
                  </li>
                )),
              ])}
              {hasMore && <li className="loading-more">后台补载中…</li>}
            </ul>
          </aside>
          <main className="app-main">
            {doc && doc.data ? (
              doc.kind === "shuffle" ? (
                <ShuffleReport
                  key={selectedId ?? undefined}
                  shuffle={doc.data}
                  videoMatchId={selectedId ?? undefined}
                  ratingDelta={selectedId ? ratingDeltas.get(selectedId) : null}
                />
              ) : (
                <MatchReport
                  key={selectedId ?? undefined}
                  source={doc.data}
                  matchId={selectedId ?? undefined}
                  ratingDelta={selectedId ? ratingDeltas.get(selectedId) : null}
                />
              )
            ) : metas.length === 0 ? (
              <div className="onboard" data-testid="onboard">
                <h2>欢迎使用 gladlog</h2>
                {wowDir == null ? (
                  <>
                    <ol>
                      <li>选择 WoW 安装目录(自动定位战斗日志并开始监控)</li>
                      <li>打一场竞技场,或导入历史日志</li>
                      <li>回来看战报、回放和 AI 分析</li>
                    </ol>
                    <button
                      className="onboard-cta"
                      onClick={() =>
                        void bridge()
                          .app.selectDirectory()
                          .then((dir) => {
                            if (dir) setWowDir(dir);
                          })
                      }
                    >
                      选择 WoW 目录…
                    </button>{" "}
                    <ImportButton />
                    <p className="onboard-hint">
                      需要开启游戏内战斗记录(高级模式);AI 分析在「设置」里配 API
                      key,不配也能看战报与回放。
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      ✅ 正在监控 <code>{wowDir}</code> —— 打一场竞技场,战报会
                      自动出现在左侧。
                    </p>
                    <p>
                      <ImportButton />
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="empty-state">选择一场对局</div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
