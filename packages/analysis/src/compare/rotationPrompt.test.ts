import { describe, expect, it } from "vitest";

import {
  buildExemplarLedPrompt,
  COMPARE_PROMPT_VERSION,
} from "./buildExemplarLedPrompt";
import type { ReferenceCell } from "./corpusTypes";
import type { VerifiedComparison } from "./verifiedComparison";

/**
 * #37 缺口三: the "how this cohort actually plays" section must reach the
 * prompt as WORDS — a digit anywhere in it invites the model to echo a raw
 * number, which claimChecker then kills (the 2026-08-12 probe's top killer).
 */

const cell = (
  rotationSummary: ReferenceCell["rotationSummary"],
): ReferenceCell => ({
  spec: "Preservation Evoker",
  bracket: "Rated Solo Shuffle",
  archetype: "*",
  buildGroup: "Flameshaper",
  sampleN: 120,
  insufficient: false,
  metrics: {},
  exemplarCrises: [],
  rotationSummary,
});

const vc = { facts: {} } as unknown as VerifiedComparison;

describe("rotation section in the exemplar-led prompt", () => {
  it("renders share buckets as words, never digits", () => {
    const prompt = buildExemplarLedPrompt(
      vc,
      cell({
        openers: [{ seq: "Dream Breath → Echo → Reversion", share: 0.62 }],
        sequences: [
          { seq: "Echo -> Reversion -> Echo", share: 0.31 },
          { seq: "Living Flame -> Echo -> Echo", share: 0.12 },
        ],
      }),
      "Preservation Evoker",
    );
    const section = prompt
      .split("How this cohort actually plays")[1]!
      .split("Write the coaching narrative")[0]!;
    expect(section).toContain("the standard opener");
    expect(section).toContain("a common chain");
    expect(section).toContain("an occasional chain");
    expect(section).not.toMatch(/\d/);
  });

  it("absent summary degrades to an explicit no-data line", () => {
    const prompt = buildExemplarLedPrompt(
      vc,
      cell(undefined),
      "Preservation Evoker",
    );
    expect(prompt).toContain("no rotation data in this corpus build");
  });

  it("prompt version is bumped so stale cohort caches invalidate", () => {
    expect(COMPARE_PROMPT_VERSION).toBe(3);
  });
});
