import { useCallback, useState } from "react";

/** Split presets. ratio is their preset value, not a parallel piece of state. */
export type ReplayLayoutMode = "split" | "map" | "gcd";

/** Draggable range of the map's share. Dragging cannot reach the extremes —
 * those are only reachable via the preset buttons. */
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;
/** Default 1/3, i.e. the 1fr 2fr that was hardcoded before the rework. */
export const SPLIT_DEFAULT = 1 / 3;

/**
 * Map height (px) in the map-only preset. The arena SVG locks its aspectRatio
 * and derives width from height — so "adjusting the height" scales the whole
 * thing, and portrait screens are no longer capped by the previously hardcoded
 * max-width. Only applies when mode==="map": in the split preset the sizing is
 * governed by ratio.
 */
export const MAP_HEIGHT_MIN = 320;
export const MAP_HEIGHT_MAX = 1400;
/** Default ≈ the map width left over from the pre-rework max-width:1100px after
 * subtracting the 140px columns on both sides (the arena is square). */
export const MAP_HEIGHT_DEFAULT = 800;

const STORAGE_KEY = "gladlog.replaySplit";

/** Clamp to [SPLIT_MIN, SPLIT_MAX]; non-finite values (dirty localStorage data)
 * fall back to the default. */
export function clampSplitRatio(desired: number): number {
  if (!Number.isFinite(desired)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, desired));
}

/** Same as above, clamped to [MAP_HEIGHT_MIN, MAP_HEIGHT_MAX]. */
export function clampMapHeight(desired: number): number {
  if (!Number.isFinite(desired)) return MAP_HEIGHT_DEFAULT;
  return Math.min(MAP_HEIGHT_MAX, Math.max(MAP_HEIGHT_MIN, desired));
}

interface Persisted {
  mode: ReplayLayoutMode;
  ratio: number;
  mapHeight: number;
  /** Compact GCD lane preset (P1-6): narrower columns, chips reduced to icons
   * only. */
  gcdCompact: boolean;
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      const mode =
        p.mode === "map" || p.mode === "gcd" || p.mode === "split"
          ? p.mode
          : "split";
      return {
        mode,
        ratio: clampSplitRatio(p.ratio as number),
        // Old records have no mapHeight → undefined → clamp falls back to the
        // default, so no separate migration is needed
        mapHeight: clampMapHeight(p.mapHeight as number),
        gcdCompact: p.gcdCompact === true,
      };
    }
    // Legacy key migration: gladlog.replayLayout used to store "map" / "full"
    const legacy = localStorage.getItem("gladlog.replayLayout");
    return {
      mode: legacy === "map" ? "map" : "split",
      ratio: SPLIT_DEFAULT,
      mapHeight: MAP_HEIGHT_DEFAULT,
      gcdCompact: false,
    };
  } catch {
    /* private browsing mode etc. */
  }
  return {
    mode: "split",
    ratio: SPLIT_DEFAULT,
    mapHeight: MAP_HEIGHT_DEFAULT,
    gcdCompact: false,
  };
}

function persist(next: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private browsing mode etc. */
  }
}

export function useReplayLayout(): {
  mode: ReplayLayoutMode;
  ratio: number;
  mapHeight: number;
  gcdCompact: boolean;
  setMode(m: ReplayLayoutMode): void;
  setRatio(r: number): void;
  setMapHeight(h: number): void;
  setGcdCompact(v: boolean): void;
} {
  const [state, setState] = useState<Persisted>(readPersisted);

  const setMode = useCallback((mode: ReplayLayoutMode) => {
    setState((prev) => {
      const next = { ...prev, mode };
      persist(next);
      return next;
    });
  }, []);

  const setRatio = useCallback((r: number) => {
    setState((prev) => {
      const next = { ...prev, ratio: clampSplitRatio(r) };
      persist(next);
      return next;
    });
  }, []);

  const setMapHeight = useCallback((h: number) => {
    setState((prev) => {
      const next = { ...prev, mapHeight: clampMapHeight(h) };
      persist(next);
      return next;
    });
  }, []);

  const setGcdCompact = useCallback((v: boolean) => {
    setState((prev) => {
      const next = { ...prev, gcdCompact: v };
      persist(next);
      return next;
    });
  }, []);

  // Effective ratio: the extreme presets ignore the user's dragged value
  const ratio =
    state.mode === "map" ? 1 : state.mode === "gcd" ? 0 : state.ratio;

  return {
    mode: state.mode,
    ratio,
    mapHeight: state.mapHeight,
    gcdCompact: state.gcdCompact,
    setMode,
    setRatio,
    setMapHeight,
    setGcdCompact,
  };
}
