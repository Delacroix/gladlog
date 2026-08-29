import { describe, expect, it } from "vitest";

import { GladLogParser } from "../src/api";
import {
  checkStructuralCompleteness,
  expectedRosterSize,
  rosterSize,
  SHUFFLE_ROUND_COUNT,
} from "../src/completeness";
import type { GladMatch, GladShuffle, GladShuffleRound } from "../src/l3/model";
import { synthArenaLog } from "../src/testing/synthLog";

function parseSynth(): GladMatch {
  const parser = new GladLogParser();
  let match: GladMatch | null = null;
  parser.on("match", (m) => (match = m));
  for (const line of synthArenaLog().split("\n")) parser.push(line);
  parser.end();
  if (!match) throw new Error("synth log did not produce a match");
  return match;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Build a shuffle from n copies of the synth 3v3 (bracket rewritten). */
function synthShuffle(n: number): GladShuffle {
  const base = parseSynth();
  const rounds: GladShuffleRound[] = [];
  for (let i = 0; i < n; i++) {
    const r = clone(base) as unknown as GladShuffleRound;
    (r as { kind: string }).kind = "shuffleRound";
    r.bracket = "Rated Solo Shuffle";
    r.sequenceNumber = i;
    rounds.push(r);
  }
  return {
    kind: "shuffle",
    rounds,
    startTime: base.startTime,
    endTime: base.endTime,
    rawLines: [],
    result: "Win",
  };
}

describe("结构完整性(checkStructuralCompleteness)", () => {
  it("合成 3v3:6 人名单 + 有结果 → 零问题", () => {
    const m = parseSynth();
    expect(m.bracket).toBe("3v3");
    expect(rosterSize(m)).toBe(6);
    expect(checkStructuralCompleteness(m)).toEqual([]);
  });

  it("名单少一人 → roster-size", () => {
    const m = clone(parseSynth());
    const id = Object.values(m.units).find((u) => u.kind === "Player")!.id;
    delete m.units[id];
    expect(checkStructuralCompleteness(m).map((i) => i.code)).toEqual([
      "roster-size",
    ]);
  });

  it("不认识的赛制不做名单断言", () => {
    const m = clone(parseSynth());
    m.bracket = "Skirmish";
    const id = Object.values(m.units).find((u) => u.kind === "Player")!.id;
    delete m.units[id];
    expect(expectedRosterSize("Skirmish")).toBeNull();
    expect(checkStructuralCompleteness(m)).toEqual([]);
  });

  it("整场 result Unknown → match-no-result", () => {
    const m = clone(parseSynth());
    m.result = "Unknown";
    m.winningTeamId = null;
    expect(checkStructuralCompleteness(m).map((i) => i.code)).toEqual([
      "match-no-result",
    ]);
  });

  it("6 轮全有赢家的 shuffle → 零问题", () => {
    expect(
      checkStructuralCompleteness(synthShuffle(SHUFFLE_ROUND_COUNT)),
    ).toEqual([]);
  });

  it("5 轮 → shuffle-round-count(轮内其他检查照常)", () => {
    const s = synthShuffle(5);
    expect(checkStructuralCompleteness(s)).toEqual([
      { code: "shuffle-round-count", detail: "rounds 5 ≠ 6" },
    ]);
  });

  it("某轮 winningTeamId null(击杀没落进日志)→ round-no-winner 带轮号", () => {
    const s = synthShuffle(6);
    s.rounds[3]!.winningTeamId = null;
    const issues = checkStructuralCompleteness(s);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "round-no-winner", roundSeq: 3 });
  });

  it("轮内名单缺人 → roster-size 带轮号", () => {
    const s = synthShuffle(6);
    const r = s.rounds[1]!;
    const id = Object.values(r.units).find((u) => u.kind === "Player")!.id;
    delete r.units[id];
    expect(checkStructuralCompleteness(s)).toEqual([
      {
        code: "roster-size",
        roundSeq: 1,
        detail: "Rated Solo Shuffle roster 5 ≠ 6",
      },
    ]);
  });
});
