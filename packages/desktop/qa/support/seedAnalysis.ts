import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  analysisCachePath,
  slotKeyOf,
  upsertSlot,
} from "../../src/shared/analysisCache";

export type SeedFinding = {
  eventIds: string[];
  severity: "high" | "med" | "low";
  category: string;
  title: string;
  explanation: string;
  /** The deep-dive block. Chips carry an **explicit instant**, so clicking one
   *  goes through onJumpT and seeks directly — unlike the "replay this moment"
   *  button, which has to look eventIds up among the candidate events (and
   *  silently no-ops when it finds nothing; see
   *  StructuredAnalysisPanel.handleJump). Seeded findings have no real
   *  candidate events to match, so the evidence-chain jump can only be tested
   *  through the chip path. */
  deepDive?: {
    text: string;
    chips: Array<{ t: number; label: string; unitNames: string[] }>;
  };
};

/**
 * Write a canned analysis result into the very cache file the main process
 * reads, so E2E has clickable findings without hitting a real API. Both the
 * path and the envelope come from src/shared/analysisCache — the same source
 * as the main process, avoiding silent cache misses caused by "the filename or
 * a field changed but the seeding side didn't follow".
 */
export function seedAnalysis(
  userData: string,
  matchId: string,
  findings: SeedFinding[],
): void {
  const fp = analysisCachePath(join(userData, "matches"), matchId, "zh");
  mkdirSync(dirname(fp), { recursive: true });
  // The v2 per-slot shape (same source as the main process' finish()/
  // getCached): seed a single slot for the default backend/model, which is
  // enough for the E2E scenarios that currently only care whether there are
  // clickable findings.
  const doc = upsertSlot(
    null,
    "zh",
    slotKeyOf("anthropic", "claude-sonnet-5"),
    { findings, dropped: 0, hadNarration: true, deepened: true },
  );
  writeFileSync(fp, JSON.stringify(doc), "utf-8");
}
