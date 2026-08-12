import { slimMatchParams } from "@gladlog/parser";

/**
 * Slimming entry point for the stored doc shape: a match is slimmed directly, a
 * shuffle round by round. Returns whether anything actually changed.
 *
 * It lives in src/shared (single-source predicate): main's self-healing path,
 * the whole-library migration in scripts/slimLibrary, and the preload-side
 * parsing fallback after raw doc bytes are passed through must all consume the
 * same function.
 * The low-level trimming semantics live in @gladlog/parser's slim.ts
 * (idempotent — rerunning it on an already-slimmed doc changes nothing).
 */
export function slimStoredDoc(doc: unknown): boolean {
  const data = (doc as { data?: { rounds?: unknown[]; units?: unknown } })
    ?.data;
  if (!data) return false;
  let changed = false;
  if (Array.isArray(data.rounds)) {
    // Null entries: the lazy per-round open path (perf-1) materializes unloaded
    // rounds as null placeholders; they are slimmed via slimStoredRound when
    // they actually load.
    for (const r of data.rounds) changed = slimStoredRound(r) || changed;
  } else if (data.units) {
    changed = slimMatchParams(data as Parameters<typeof slimMatchParams>[0]);
  }
  return changed;
}

/** Per-round slimming — the same predicate slimStoredDoc applies to each round,
 * exported for the lazy round-load path (a round parsed on its own must be
 * slimmed exactly the way the whole-doc path would have). */
export function slimStoredRound(round: unknown): boolean {
  if (!round || !(round as { units?: unknown }).units) return false;
  return slimMatchParams(round as Parameters<typeof slimMatchParams>[0]);
}
