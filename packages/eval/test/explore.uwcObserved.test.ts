// packages/eval/test/explore.uwcObserved.test.ts
/**
 * TDD fixture for Task 4 (技能事实地基) — 语料观测线: does a unit's
 * SPELL_CAST_SUCCESS fall inside its own active stun-aura window
 * (SPELL_AURA_APPLIED..SPELL_AURA_REMOVED, keyed by dest GUID, spellId ∈
 * caller-supplied stun-aura-id set)? Raw line shape copied verbatim from a
 * real `matches/<id>/raw.txt` line (field-for-field: GUIDs/names/spellIds swapped
 * for readability, the advanced-info tail left byte-identical since
 * `decodeAdvanced` is unused here but must not throw) — see
 * `packages/eval/src/explore/storeAccess.ts`'s header for why this repo's
 * corpus tooling never re-derives the parser: `@gladlog/parser`'s `parseLine`
 * is the shared predicate for "what does this raw line mean" (CLAUDE.md
 * shared-predicate rule) — same timestamp parser / field decoders every other
 * consumer of raw.txt uses, not a bespoke regex.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_STUN_WINDOW_MS,
  observedCastsInCc,
  observedCastsWhileStunned,
} from "../src/explore/uwcObserved";

const STUN_AURA = "999001"; // synthetic aura id, kept out of any real DR set on purpose

/** Advanced-info tail (`decodeAdvanced` fields 11+) copied verbatim from a
 * real raw.txt SPELL_CAST_SUCCESS line — unused by the function under test,
 * kept byte-identical so parseLine never has a reason to reject the line. */
const ADV_TAIL =
  "0000000000000000,566540,566540,2916,2804,2513,2533,0,0,0,273000,273000,0,1281.30,1709.34,0,4.8313,291";

function auraApplied(
  ts: string,
  srcGuid: string,
  destGuid: string,
  spellId: string,
): string {
  return `6/15/2026 ${ts}-4  SPELL_AURA_APPLIED,${srcGuid},"Src-Realm-US",0x548,0x0,${destGuid},"Dest-Realm-US",0x10512,0x0,${spellId},"眩晕术",0x1,DEBUFF`;
}

function auraRemoved(
  ts: string,
  srcGuid: string,
  destGuid: string,
  spellId: string,
): string {
  return `6/15/2026 ${ts}-4  SPELL_AURA_REMOVED,${srcGuid},"Src-Realm-US",0x548,0x0,${destGuid},"Dest-Realm-US",0x10512,0x0,${spellId},"眩晕术",0x1,DEBUFF,0`;
}

function castSuccess(
  ts: string,
  casterGuid: string,
  spellId: string,
  spellName: string,
): string {
  return `6/15/2026 ${ts}-4  SPELL_CAST_SUCCESS,${casterGuid},"Src-Realm-US",0x10512,0x0,${casterGuid},"Src-Realm-US",0x10512,0x0,${spellId},"${spellName}",0x2,${casterGuid},${ADV_TAIL}`;
}

describe("observedCastsWhileStunned", () => {
  it("counts only the cast inside the stun window, not the one outside or another unit's", () => {
    const A = "Player-57-AAAAAAA1"; // the stunned unit (dest of the aura)
    const B = "Player-57-BBBBBBB2"; // the enemy applying/removing the stun

    const raw = [
      "6/15/2026 01:08:34.614-4  ARENA_MATCH_START,572,41,3v3,1",
      auraApplied("01:08:35.100", B, A, STUN_AURA),
      castSuccess("01:08:35.200", A, "642", "圣盾术"), // inside stun -> counts
      castSuccess("01:08:35.250", B, "19750", "圣光闪现"), // different unit, never stunned -> noise
      auraRemoved("01:08:35.900", B, A, STUN_AURA),
      castSuccess("01:08:36.000", A, "6673", "战斗怒吼"), // after removal -> outside stun
    ].join("\n");

    const observed = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect([...observed.entries()]).toEqual([["642", 1]]);
  });

  it("treats a cast at the exact removal instant as outside the stun (conservative tie-break), regardless of line order", () => {
    const A = "Player-57-AAAAAAA1";
    const B = "Player-57-BBBBBBB2";

    const raw = [
      auraApplied("01:08:35.100", B, A, STUN_AURA),
      // CAST line appears BEFORE the REMOVED line at the identical timestamp —
      // if the implementation just trusted file order it would wrongly count
      // this as "inside stun"; the spec requires the tie to resolve to outside.
      castSuccess("01:08:35.900", A, "642", "圣盾术"),
      auraRemoved("01:08:35.900", B, A, STUN_AURA),
    ].join("\n");

    const observed = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect(observed.size).toBe(0);
  });

  it("ignores a REMOVED with no prior APPLIED (stun pre-dates the log window) without throwing or phantom-counting", () => {
    const A = "Player-57-AAAAAAA1";
    const B = "Player-57-BBBBBBB2";

    const raw = [
      // stun already active when the log starts capturing — only REMOVED is seen
      auraRemoved("01:08:35.100", B, A, STUN_AURA),
      castSuccess("01:08:35.200", A, "642", "圣盾术"), // no active stun tracked -> does not count
    ].join("\n");

    const observed = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect(observed.size).toBe(0);
  });

  it("resets active-stun tracking at an ARENA_MATCH_START boundary (no cross-round leakage)", () => {
    const A = "Player-57-AAAAAAA1";
    const B = "Player-57-BBBBBBB2";

    const raw = [
      auraApplied("01:08:35.100", B, A, STUN_AURA), // never explicitly removed before the round ends
      "6/15/2026 01:09:00.000-4  ARENA_MATCH_START,572,41,3v3,2",
      castSuccess("01:09:00.500", A, "642", "圣盾术"), // new round -> not stunned
    ].join("\n");

    const observed = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect(observed.size).toBe(0);
  });

  it('auto-expires a window whose REMOVED never arrives, past MAX_STUN_WINDOW_MS — found empirically: WoW\'s own combat log occasionally drops the REMOVED event, which without this cap would falsely mark the unit "stunned" for the rest of the round', () => {
    expect(MAX_STUN_WINDOW_MS).toBeGreaterThan(0);
    const A = "Player-57-AAAAAAA1";
    const B = "Player-57-BBBBBBB2";

    const raw = [
      auraApplied("01:08:35.000", B, A, STUN_AURA), // no REMOVED ever follows — a dropped log event
      castSuccess("01:08:37.000", A, "642", "圣盾术"), // 2s later, well within the cap -> still counts
      castSuccess("01:08:47.001", A, "6673", "战斗怒吼"), // 12.001s later, past the 10s cap -> does not
    ].join("\n");

    const observed = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect([...observed.entries()]).toEqual([["642", 1]]);
  });
});

describe("observedCastsInCc (Task E generalization: any DR category's aura set, not just stun)", () => {
  const FEAR_AURA = "999002"; // synthetic disorient-category aura id, kept out of any real DR set on purpose

  it("counts a cast landing inside a non-stun (fear/disorient-family) aura window — same walker, injected aura set", () => {
    const A = "Player-57-AAAAAAA1"; // the feared unit (dest of the aura)
    const B = "Player-57-BBBBBBB2"; // the caster applying/removing the fear

    const raw = [
      auraApplied("01:08:35.100", B, A, FEAR_AURA),
      castSuccess("01:08:35.400", A, "22812", "树皮术"), // inside fear window -> counts
      auraRemoved("01:08:35.900", B, A, FEAR_AURA),
      castSuccess("01:08:36.000", A, "47585", "消散"), // after removal -> outside window
    ].join("\n");

    const observed = observedCastsInCc(raw, new Set([FEAR_AURA]));

    expect([...observed.entries()]).toEqual([["22812", 1]]);
  });

  it("is the same function observedCastsWhileStunned now delegates to (pinned alias, identical output for a stun-set input)", () => {
    const A = "Player-57-AAAAAAA1";
    const B = "Player-57-BBBBBBB2";

    const raw = [
      auraApplied("01:08:35.100", B, A, STUN_AURA),
      castSuccess("01:08:35.200", A, "642", "圣盾术"),
      auraRemoved("01:08:35.900", B, A, STUN_AURA),
    ].join("\n");

    const viaGeneralized = observedCastsInCc(raw, new Set([STUN_AURA]));
    const viaAlias = observedCastsWhileStunned(raw, new Set([STUN_AURA]));

    expect([...viaAlias.entries()]).toEqual([...viaGeneralized.entries()]);
  });
});
