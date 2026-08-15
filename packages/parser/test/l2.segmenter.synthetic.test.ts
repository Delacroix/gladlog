import { parseLine } from "../src/l1/parseLine";
import { Segmenter } from "../src/l2/segmenter";
import type { Segment, ShuffleClose } from "../src/l2/types";

const TZ = { timezone: "UTC" } as const;

function makeLines(specs: string[]): string[] {
  // Each entry in specs is 'event and parameters'; timestamps advance by 1s
  return specs.map(
    (s, i) => `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}`,
  );
}

function run(raws: string[]) {
  const matches: { seg: Segment; end: ReturnType<typeof parseLine> }[] = [];
  const shuffles: ShuffleClose[] = [];
  const diags: { code: string }[] = [];
  const seg = new Segmenter();
  seg.onMatch((s, end) => matches.push({ seg: s, end }));
  seg.onShuffle((s) => shuffles.push(s));
  seg.onDiagnostic((d) => diags.push(d));
  for (const raw of raws) {
    const p = parseLine(raw, TZ);
    if (p) seg.push(p, raw);
  }
  seg.end();
  return { matches, shuffles, diags };
}

const CAST =
  'SPELL_CAST_SUCCESS,Player-1-A,"Alice-X",0x512,0x80000000,0000000000000000,nil,0x80000000,0x80000000,2983,"Sprint",0x1,Player-1-A,0000000000000000,100,100,0,0,0,0,0,0,3,10,10,0,1.00,-1.00,0,1.0,70';

describe("Segmenter state machine (synthetic)", () => {
  it("① normal 3v3: one match with interior records", () => {
    const r = run(
      makeLines([
        "ARENA_MATCH_START,1825,41,3v3,1",
        CAST,
        CAST,
        "ARENA_MATCH_END,1,30,1500,1501",
      ]),
    );
    expect(r.matches).toHaveLength(1);
    expect(r.shuffles).toHaveLength(0);
    expect(r.matches[0]!.seg.kind).toBe("match");
    expect(r.matches[0]!.seg.bracket).toBe("3v3");
    expect(
      r.matches[0]!.seg.records.filter(
        (x) => x.eventName === "SPELL_CAST_SUCCESS",
      ),
    ).toHaveLength(2);
    expect(r.matches[0]!.end?.arenaEnd?.winningTeamId).toBe(1);
  });

  it("② double START (non-shuffle): diagnostic + second match completes", () => {
    const r = run(
      makeLines([
        "ARENA_MATCH_START,1911,40,2v2,1",
        CAST,
        "ARENA_MATCH_START,1911,40,2v2,1",
        CAST,
        "ARENA_MATCH_END,0,33,1658,1970",
      ]),
    );
    expect(r.matches).toHaveLength(1);
    expect(r.diags.some((d) => d.code === "DOUBLE_START")).toBe(true);
    expect(
      r.matches[0]!.seg.records.filter(
        (x) => x.eventName === "SPELL_CAST_SUCCESS",
      ),
    ).toHaveLength(1);
  });

  it("③ shuffle: 3 STARTs + END → one ShuffleClose with rounds 0,1,2", () => {
    const r = run(
      makeLines([
        "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0",
        CAST,
        "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0",
        CAST,
        CAST,
        "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0",
        "ARENA_MATCH_END,0,155,1729,1730",
      ]),
    );
    expect(r.matches).toHaveLength(0);
    expect(r.shuffles).toHaveLength(1);
    const s = r.shuffles[0]!;
    expect(s.rounds).toHaveLength(3);
    expect(s.rounds.map((x) => x.sequenceNumber)).toEqual([0, 1, 2]);
    expect(s.rounds[0]!.kind).toBe("shuffleRound");
    expect(
      s.rounds[1]!.records.filter((x) => x.eventName === "SPELL_CAST_SUCCESS"),
    ).toHaveLength(2);
    expect(s.end.arenaEnd?.winningTeamId).toBe(0);
    expect(r.diags.filter((d) => d.code === "DOUBLE_START")).toHaveLength(0);
  });

  it("④ COMBAT_LOG_VERSION / ZONE_CHANGE do not break a segment", () => {
    const r = run(
      makeLines([
        "ARENA_MATCH_START,1505,38,Rated Solo Shuffle,0",
        CAST,
        "COMBAT_LOG_VERSION,21,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,11.0.2,PROJECT_ID,1",
        'ZONE_CHANGE,1505,"Nagrand Arena",0',
        CAST,
        "ARENA_MATCH_START,1505,38,Rated Solo Shuffle,0",
        "ARENA_MATCH_END,1,27,1428,1446",
      ]),
    );
    expect(r.shuffles).toHaveLength(1);
    expect(r.shuffles[0]!.rounds).toHaveLength(2);
    expect(
      r.shuffles[0]!.rounds[0]!.records.filter(
        (x) => x.eventName === "SPELL_CAST_SUCCESS",
      ),
    ).toHaveLength(2);
  });

  it("⑤ EOF with open segment → UNCLOSED_SEGMENT, nothing emitted", () => {
    const r = run(makeLines(["ARENA_MATCH_START,1825,41,3v3,1", CAST]));
    expect(r.matches).toHaveLength(0);
    expect(r.shuffles).toHaveLength(0);
    expect(r.diags.some((d) => d.code === "UNCLOSED_SEGMENT")).toBe(true);
  });

  it("⑥ orphan END → ORPHAN_END diagnostic, no crash", () => {
    const r = run(makeLines([CAST, "ARENA_MATCH_END,1,30,1500,1501"]));
    expect(r.matches).toHaveLength(0);
    expect(r.diags.some((d) => d.code === "ORPHAN_END")).toBe(true);
  });

  // #21.8: mid-shuffle log rotation must flush the rounds that already
  // completed (their round-ending marker -- the next round's
  // ARENA_MATCH_START -- was seen) instead of discarding them along with the
  // genuinely truncated in-flight round.
  const SHUFFLE_START = "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0";
  const threeCompleteRoundsLines = [
    SHUFFLE_START,
    CAST,
    SHUFFLE_START,
    CAST,
    CAST,
    SHUFFLE_START,
    CAST,
    CAST,
    CAST,
  ];

  it("⑦ EOF mid-round-4: rounds 1-3 flush, round 4 (partial) is dropped", () => {
    const r = run(
      makeLines([
        ...threeCompleteRoundsLines,
        SHUFFLE_START, // round 4 starts...
        CAST, // ...but the file ends mid-round, no closing marker for it
      ]),
    );
    expect(r.matches).toHaveLength(0);
    expect(r.shuffles).toHaveLength(1);
    const s = r.shuffles[0]!;
    expect(s.rounds).toHaveLength(3);
    expect(s.rounds.map((x) => x.sequenceNumber)).toEqual([0, 1, 2]);
    // round 4's CAST never lands anywhere -- confirm it was truly dropped,
    // not silently folded into round 3.
    const totalCasts = s.rounds.reduce(
      (n, round) =>
        n +
        round.records.filter((x) => x.eventName === "SPELL_CAST_SUCCESS")
          .length,
      0,
    );
    expect(totalCasts).toBe(1 + 2 + 3); // rounds 1,2,3's own CAST counts only
    expect(r.diags.some((d) => d.code === "UNCLOSED_SEGMENT")).toBe(true);
    // No ARENA_MATCH_END exists for an EOF flush, so `end` is the truncated
    // round's own ARENA_MATCH_START -- a real captured line, not a fabricated
    // ARENA_MATCH_END.
    expect(s.end.eventName).toBe("ARENA_MATCH_START");
    expect(s.end.arenaEnd).toBeUndefined();
  });

  it("⑧ EOF-flushed rounds 1-3 are byte-identical to the same rounds in a normally-closed shuffle", () => {
    const normal = run(
      makeLines([
        ...threeCompleteRoundsLines,
        "ARENA_MATCH_END,0,155,1729,1730",
      ]),
    );
    const truncated = run(
      makeLines([...threeCompleteRoundsLines, SHUFFLE_START, CAST]),
    );
    expect(normal.shuffles[0]!.rounds).toEqual(truncated.shuffles[0]!.rounds);
  });

  it("⑨ rotation at exact round boundary (no interior lines for the in-progress round): all completed rounds flush", () => {
    const r = run(
      makeLines([
        SHUFFLE_START,
        CAST,
        SHUFFLE_START,
        CAST,
        CAST,
        SHUFFLE_START, // round 3 starts right as the file ends -- no records at all
      ]),
    );
    expect(r.shuffles).toHaveLength(1);
    const s = r.shuffles[0]!;
    expect(s.rounds).toHaveLength(2);
    expect(s.rounds.map((x) => x.sequenceNumber)).toEqual([0, 1]);
    expect(s.end.eventName).toBe("ARENA_MATCH_START");
  });

  it("⑩ EOF during round 1 (zero completed rounds): nothing flushes, same as before the fix", () => {
    const r = run(makeLines([SHUFFLE_START, CAST]));
    expect(r.shuffles).toHaveLength(0);
    expect(r.matches).toHaveLength(0);
    expect(r.diags.some((d) => d.code === "UNCLOSED_SEGMENT")).toBe(true);
  });
});
