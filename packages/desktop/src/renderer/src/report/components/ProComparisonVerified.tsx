import { useEffect, useMemo, useRef, useState } from "react";
import type { ReportSource } from "../derive/types";
import { cohortDims } from "../derive/cohortDims";
import { CohortDimsTable } from "./CohortDimsTable";
import { bridge } from "../../bridge";
import {
  analysisDataReady,
  computeDpsMetrics,
  computeHealerMetrics,
  ensureAnalysisData,
  enemyCompSignature,
  specToString,
  isHealerSpec,
  enemyCompArchetype,
} from "@gladlog/analysis";
import { CombatUnitReaction } from "@gladlog/parser-compat";
import datagenManifest from "@gladlog/analysis/src/data/datagen-manifest.json";
import { SPEC_NAMES_ZH } from "../data/specNames";
import { toLegacySafe } from "../derive/legacySource";
import { makeRichText } from "../derive/inlineRich";

type CompareResult = {
  verifiedComparison: {
    dims: Array<{
      key: string;
      value: number | null;
      p10: number;
      p50: number;
      p90: number;
      percentile: number;
      verdict: string;
    }>;
    facts: Record<string, string>;
  };
  report: string | null;
  droppedReason: string | null;
  cellMeta: {
    enemyComp?: string | null;
    durationP50?: number | null;
    firstKillTop?: { spec: string; pct: number } | null;
    spec: string;
    bracket: string;
    archetype: string;
    buildGroup: string;
    sampleN: number;
    fellBackTo: string;
  } | null;
};
type State = "idle" | "running" | "done" | "error";

const specZh = (spec: string): string => SPEC_NAMES_ZH[spec] ?? spec;

export function ProComparisonVerified({
  source,
  matchId,
  runSignal,
  hideActions,
}: {
  source: ReportSource;
  matchId: string;
  /** Merged button: a change of the nonce triggers the comparison (so it runs
   * together with AI analysis from one click). */
  runSignal?: number;
  /** Hide this panel's own action row while in merged-button mode. */
  hideActions?: boolean;
}) {
  const [state, setState] = useState<State>("idle");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string>("");
  const [lang, setLang] = useState<"en" | "zh">("zh");
  /** The mount check (getState → getCached) came back with nothing in flight
   * and nothing cached — the precondition for the auto-run backfill below. */
  const [emptyChecked, setEmptyChecked] = useState(false);

  useEffect(() => {
    // The coach reply language also decides the panel/table copy language; the
    // bridge surface may be missing (fixture stub)
    void (async () => {
      try {
        const s = await bridge().settings.get();
        if (s?.aiLanguage === "en" || s?.aiLanguage === "zh")
          setLang(s.aiLanguage);
      } catch {
        /* default zh */
      }
    })();
  }, []);

  // Restore any existing result on mount / match change. Reset state on matchId
  // change (the panel is not remounted per match) and guard against a late
  // resolve from a previous match overwriting the current one.
  //
  // getState first, getCached as the fallback (root-cause fix, 2026-08-02):
  // unmounting the AI tab (switching to report / replay / events / video, and
  // likewise changing shuffle rounds) leaves nobody listening for the
  // compare:done the main process emits — IPC events are not queued or replayed,
  // so the result is lost for good. Meanwhile the runSignal effect below
  // initialises lastSignal to the current nonce on the new instance, so the
  // re-run branch never fires either. And NO_COHORT / compare:error are
  // **never written to compare.json** at all, so getCached cannot save us —
  // what the user sees is "switch a tab, come back, the cohort panel is gone".
  // getState is the terminal state main keeps in memory (see CompareState in
  // main/compare.ts): losing the event no longer means losing the result, and
  // we do not burn another round of tokens.
  // When the getState surface is missing (fixture stub / older preload) we fall
  // back to getCached silently.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setState("idle");
    setError("");
    setEmptyChecked(false);
    void (async () => {
      const st = await bridge()
        .compare.getState?.(matchId)
        .catch(() => null);
      if (cancelled) return;
      if (st && st.phase !== "idle") {
        if (st.phase === "done") {
          setResult(st.result as CompareResult);
          setState("done");
        } else if (st.phase === "error") {
          setError(st.message);
          setState("error");
        } else {
          setState("running");
        }
        return;
      }
      const cached = (await bridge().compare.getCached(
        matchId,
      )) as CompareResult | null;
      if (cancelled) return;
      if (cached) {
        setResult(cached);
        setState("done");
      } else {
        // Both exits empty: nothing in flight, nothing on disk. Only now may
        // the auto-run below consider firing — flagging *after* the async
        // checks (rather than gating on state alone) is what stops the
        // auto-run from racing ahead of a cached result that is still
        // resolving.
        setEmptyChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  // Subscribe to the (verified) done + error events. We deliberately do NOT
  // display onDelta text: streamed deltas are interpolated but not yet
  // claim-checked, so only the final claimChecked result is rendered.
  useEffect(() => {
    const offDelta = bridge().compare.onDelta((d) => {
      if (d.matchId === matchId) setState("running");
    });
    const offDone = bridge().compare.onDone(
      (d: { matchId: string; result: unknown }) => {
        if (d.matchId !== matchId) return;
        setResult(d.result as CompareResult);
        setState("done");
        setError("");
      },
    );
    const offError = bridge().compare.onError((d) => {
      if (d.matchId !== matchId) return;
      setState("error");
      setError(d.message);
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, [matchId]);

  // Derive the compare input from the parsed match: the Friendly healer's
  // metrics, spec, talents, and the enemy-comp archetype. Defensive: any
  // shape mismatch yields null (button disabled) rather than crashing.
  const input = useMemo(() => {
    try {
      // toLegacySafe, not bare toLegacyMatch (desktop-dev rule): a doc with a
      // stripped event array throws inside the conversion, this useMemo's
      // catch turns that into input=null, and the comparison silently becomes
      // impossible for that match. Production docs are complete today
      // (measured 100/100 on the library), so this is hardening plus making
      // the trimmed test fixture usable — not a behavior change.
      const legacy = toLegacySafe(source);
      const players = Object.values(legacy.units).filter((u) => u.info);
      // owner = the player who recorded the log (same semantics as the AI
      // panel); a DPS recorder uses the DPS metric set (pro-comparison P1),
      // and when none is found we fall back to the friendly healer (old
      // behavior).
      const owner =
        players.find(
          (u) =>
            u.id === legacy.playerId &&
            u.reaction === CombatUnitReaction.Friendly,
        ) ??
        players.find(
          (u) =>
            isHealerSpec(u.spec) && u.reaction === CombatUnitReaction.Friendly,
        );
      if (!owner) return null;
      const enemies = players.filter((u) => u.reaction !== owner.reaction);
      const metrics = isHealerSpec(owner.spec)
        ? computeHealerMetrics(legacy, owner.name)
        : computeDpsMetrics(legacy, owner.name);
      const talents = (owner.info?.talents ?? [])
        .map((t: { id1: number }) => t.id1)
        .filter(Boolean);
      return {
        matchId,
        healerMetrics: metrics as unknown as Record<string, number | null>,
        enemyComp: enemyCompSignature(enemies.map((e) => specToString(e.spec))),
        spec: specToString(owner.spec),
        talents,
        bracket: legacy.startInfo?.bracket ?? "unknown",
        archetype: enemyCompArchetype(enemies),
        wowBuild: (datagenManifest as { build?: string }).build ?? "0.0.0.0",
      };
    } catch {
      return null;
    }
  }, [source, matchId]);

  // Inline icons (#15): the spellNames table loads in the background and may
  // not be ready at first evaluation → englishNameIndex() is null and rich
  // rendering degrades to plain text permanently. Once dataReady flips true we
  // rebuild the rich-text function so the display path heals itself (same
  // pattern as StructuredAnalysisPanel).
  const [dataReady, setDataReady] = useState(analysisDataReady);
  useEffect(() => {
    if (dataReady) return;
    let alive = true;
    void ensureAnalysisData().then(() => {
      if (alive) setDataReady(true);
    });
    return () => {
      alive = false;
    };
  }, [dataReady]);

  const rich = useMemo(
    () => makeRichText(source, lang),
    [source, lang, dataReady],
  );

  const handleCompare = async () => {
    // Silent no-op fix (2026-08-02): when input is null (no owner resolved, or
    // the metric computation threw — see the useMemo's catch above) this used to
    // just return, setting neither an error nor a state. The panel stayed blank
    // and neither the user nor a developer got any clue. Now it says so.
    if (!input) {
      setError(
        lang === "zh"
          ? "无法从本场日志推出对比所需的指标(找不到记录者/指标计算失败),暂无法对比。"
          : "Cannot derive comparison metrics from this match (no owner found or metrics failed).",
      );
      setState("error");
      return;
    }
    setError("");
    setState("running");
    // The first half of the main-process compare.run (loadCorpus / lookupCell /
    // verifiedComparison) sits outside its own try, so anything thrown there
    // rejects this invoke. The call site is `void handleCompare()`, so not
    // catching it means an unhandled rejection plus a panel stuck on "running".
    try {
      await bridge().compare.run(input);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  // Merged button (user feedback): a nonce change on the main AI-analysis
  // button also triggers the comparison
  const lastSignal = useRef(runSignal ?? 0);
  useEffect(() => {
    if (runSignal == null || runSignal === lastSignal.current) return;
    lastSignal.current = runSignal;
    void handleCompare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal]);

  // Auto-run backfill (prod triage 2026-08-04): the runSignal nonce above was
  // the comparison's ONLY trigger in the whole product — hideActions removes
  // this panel's own button, and the batch / auto-analyze pipelines in main
  // never touch compare at all. So a match analyzed by any path other than the
  // merged button ends up with an analysis and no comparison, and no visible
  // way to ever get one ("分析生成了但没有同水平对比"). Disproven alternates,
  // measured on the real library: cohort coverage is not the cause (250/250
  // recent matches resolve a cell), nor is the bracket input (toLegacyMatch
  // synthesizes startInfo.bracket from the doc).
  //
  // When the mount check came back truly empty AND the match already has an
  // analysis, run once automatically. Gating on the analysis cache keeps the
  // model spend tied to "this match was analyzed" — opening the AI tab on a
  // never-analyzed match still runs nothing, exactly as before. One shot per
  // match id: an error outcome stays on screen rather than retry-looping.
  const autoRanFor = useRef<string | null>(null);
  useEffect(() => {
    if (!emptyChecked || state !== "idle" || result !== null || !input) return;
    if (autoRanFor.current === matchId) return;
    let cancelled = false;
    void (async () => {
      let hasAnalysis = false;
      try {
        const a = (await bridge().analysis.getState(matchId)) as {
          cached: unknown;
        } | null;
        // getState's `cached` is the analysis panel's own "an analysis exists"
        // judgment (active slot content, single source on the main side).
        hasAnalysis = a?.cached != null;
      } catch {
        // Stub bridge without the analysis surface (test bed / fixtures):
        // keep the old do-nothing behavior.
      }
      if (cancelled || !hasAnalysis) return;
      if (autoRanFor.current === matchId) return;
      autoRanFor.current = matchId;
      void handleCompare();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyChecked, state, result, input, matchId]);

  const buttonText =
    state === "running"
      ? "对比中…"
      : state === "done"
        ? "重新对比"
        : "vs 高分群体";

  return (
    <div className="rpt-ai-panel">
      {error && <div className="rpt-ai-error">{error}</div>}
      {result && result.cellMeta && (
        <div className="rpt-ai-body">
          <h3>{lang === "zh" ? "vs 同水平高手" : "vs your cohort"}</h3>
          <p
            style={{
              color: "var(--ink-2)",
              fontSize: "12px",
              marginBottom: "12px",
            }}
          >
            {result.cellMeta.enemyComp
              ? lang === "zh"
                ? `对阵同阵容(${result.cellMeta.enemyComp})的高手场 · `
                : `vs same comp (${result.cellMeta.enemyComp}) · `
              : ""}
            {lang === "zh"
              ? specZh(result.cellMeta.spec)
              : result.cellMeta.spec}{" "}
            · {result.cellMeta.bracket} · {result.cellMeta.archetype} ·{" "}
            {result.cellMeta.buildGroup} build ·{" "}
            {lang === "zh"
              ? `样本 ${result.cellMeta.sampleN} 场`
              : `N=${result.cellMeta.sampleN}`}
            {result.cellMeta.enemyComp &&
              result.cellMeta.durationP50 != null && (
                <>
                  {" · 时长中位 "}
                  {Math.floor(result.cellMeta.durationP50 / 60)}:
                  {String(result.cellMeta.durationP50 % 60).padStart(2, "0")}
                  {result.cellMeta.firstKillTop
                    ? ` · ${result.cellMeta.firstKillTop.pct}% 先杀 ${result.cellMeta.firstKillTop.spec}`
                    : ""}
                </>
              )}
          </p>
          <CohortDimsTable
            lang={lang}
            rows={cohortDims(result.verifiedComparison.dims, lang)}
          />
          {result.report !== null ? (
            <p style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>
              {rich(result.report)}
            </p>
          ) : (
            <div>
              <p
                style={{
                  color: "var(--mute)",
                  fontSize: "12px",
                  fontStyle: "italic",
                }}
              >
                {lang === "zh"
                  ? "仅展示实测数据(AI 解说未生成)"
                  : "Showing measured numbers only"}
              </p>
              {result.droppedReason && (
                <p style={{ color: "var(--mute)", fontSize: "11px" }}>
                  {lang === "zh" ? "原因:" : "Reason: "}
                  {result.droppedReason}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {result && !result.cellMeta && (
        <div className="rpt-ai-body">
          <p style={{ color: "var(--ink-2)", fontSize: "12px" }}>
            {lang === "zh"
              ? "该专精/阵容的高手参照样本还不够,暂无法对比。"
              : "Not enough cohort data for this build and comp yet."}
          </p>
        </div>
      )}
      {/* Empty state (user report, 2026-08-02: "the cohort panel sometimes
          doesn't show up"): when result was null this component rendered not a
          single visible node — with hideActions it did not even render the
          action row — so the whole block was an empty box that reads as "the
          section disappeared". And a null result is the normal case, not an
          exceptional one: the compare cache is governed by three invalidation
          predicates (corpusVersion / prompt version / language), and after a
          remount lastSignal is initialised to the current nonce so the auto
          re-run branch never fires again — switch a tab and come back and it
          never returns. The empty state has to announce itself and offer a way
          out (the actions row below is forced to render when there is no
          result). */}
      {!result && !error && (
        <div className="rpt-ai-body">
          <h3>{lang === "zh" ? "vs 同水平高手" : "vs your cohort"}</h3>
          <p className="rpt-ai-none" data-testid="cohort-empty">
            {state === "running"
              ? lang === "zh"
                ? "正在与同水平高手对比…"
                : "Comparing against your cohort…"
              : lang === "zh"
                ? "本场还没有群体对比结果 —— 点上方「AI 分析」一键同跑,或点下面的按钮单独对比。"
                : "No cohort comparison for this match yet — run the AI analysis above, or compare on its own below."}
          </p>
        </div>
      )}
      {input && typeof input.healerMetrics.healingGapCount === "number" && (
        // Healing gaps (#10 T3): not part of the cohort comparison (absent
        // from SCALAR_METRICS / the corpus), so we show the measured scalar
        // directly — the same lightweight copy as the cohort comparison rows.
        <p
          style={{
            color: "var(--ink-2)",
            fontSize: "12px",
            marginTop: "4px",
          }}
        >
          {lang === "zh"
            ? `本场治疗空窗 ${(input.healerMetrics.healingGapSeconds ?? 0).toFixed(1)}s · ${input.healerMetrics.healingGapCount} 次`
            : `Healing gaps this match: ${(input.healerMetrics.healingGapSeconds ?? 0).toFixed(1)}s over ${input.healerMetrics.healingGapCount} gap(s)`}
        </p>
      )}
      {/* hideActions means "once there is a result, don't put a duplicate
          button next to the merged one" — not "never show a button". With no
          result this escape hatch has to stay, otherwise a blank block leaves
          the user with nothing to do but re-run the whole match analysis. */}
      {(!hideActions || !result) && (
        <div className="rpt-ai-actions">
          <button
            onClick={handleCompare}
            disabled={!input || state === "running"}
          >
            {buttonText}
          </button>
        </div>
      )}
    </div>
  );
}
