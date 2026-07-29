import { describe, expect, it } from "vitest";

import type { DetailedMatchStub } from "./feedClient";
import {
  buildCompQueryString,
  dedupeByLogObject,
  matchesSpecFilter,
  parseSpecArg,
  stubToManifestEntry,
} from "./pvpLogFetch";

function stub(over: Partial<DetailedMatchStub> = {}): DetailedMatchStub {
  return {
    typename: "ArenaMatchDataStub",
    id: "m1",
    logObjectUrl: "https://storage.googleapis.com/x/m1",
    playerId: "Player-1",
    hasAdvancedLogging: true,
    durationInSeconds: 120,
    bracket: "3v3",
    startTime: 1785365331361,
    result: 1,
    playerTeamRating: 2450,
    winningTeamId: "0",
    playerTeamId: "0",
    team0MMR: 2400,
    team1MMR: 2410,
    units: [
      {
        id: "Player-1",
        name: "Rec-Realm",
        spec: "264",
        reaction: 1,
        info: { specId: "264", personalRating: 2460, teamId: "0" },
      },
      {
        id: "Player-2",
        name: "Mate-Realm",
        spec: "263",
        reaction: 1,
        info: { specId: "263", personalRating: 2440, teamId: "0" },
      },
      {
        id: "Player-3",
        name: "Foe-Realm",
        spec: "105",
        reaction: 2,
        info: { specId: "105", personalRating: 2390, teamId: "1" },
      },
      // 宠物/图腾:无 info,绝不能混进 players
      {
        id: "Creature-1",
        name: "Healing Stream Totem",
        spec: "0",
        reaction: 1,
      },
    ],
    ...over,
  };
}

describe("parseSpecArg", () => {
  it("accepts numeric ids, enum names, and mixed comma lists", () => {
    expect(parseSpecArg("264")).toEqual(["264"]);
    expect(parseSpecArg("Shaman_Restoration")).toEqual(["264"]);
    expect(parseSpecArg("Druid_Restoration, 263")).toEqual(["105", "263"]);
  });
  it("throws on unknown names instead of silently widening the query", () => {
    expect(() => parseSpecArg("Shaman_Resto")).toThrow(/unknown spec/);
  });
});

describe("buildCompQueryString", () => {
  it("joins specIds in string lexicographic order (server index order)", () => {
    // "1468" < "263" 字典序——这是服务端索引的真实排序,数值序会查空
    expect(buildCompQueryString(["263", "1468"])).toBe("1468_263");
    expect(buildCompQueryString(["105", "263"])).toBe("105_263");
  });
});

describe("matchesSpecFilter", () => {
  it("recorder role matches only the uploader's own spec", () => {
    expect(matchesSpecFilter(stub(), ["264"], "recorder")).toBe(true);
    // 105 在场(敌方)但记录者是 264
    expect(matchesSpecFilter(stub(), ["105"], "recorder")).toBe(false);
  });
  it("any role matches any unit on either side", () => {
    expect(matchesSpecFilter(stub(), ["105"], "any")).toBe(true);
    expect(matchesSpecFilter(stub(), ["270"], "any")).toBe(false);
  });
  it("empty spec list passes everything", () => {
    expect(matchesSpecFilter(stub(), [], "recorder")).toBe(true);
  });
});

describe("dedupeByLogObject", () => {
  it("keeps one stub per shared shuffle log object", () => {
    const rounds = [
      stub({ id: "r1", logObjectUrl: "u/shared" }),
      stub({ id: "r2", logObjectUrl: "u/shared" }),
      stub({ id: "m2", logObjectUrl: "u/other" }),
    ];
    expect(dedupeByLogObject(rounds).map((s) => s.id)).toEqual(["r1", "m2"]);
  });
});

describe("stubToManifestEntry", () => {
  it("extracts recorder, per-player specs/ratings, and drops non-players", () => {
    const e = stubToManifestEntry(stub(), "m1.txt");
    expect(e.recorder).toEqual({
      name: "Rec-Realm",
      spec: "264",
      teamId: "0",
      personalRating: 2460,
    });
    expect(e.players).toHaveLength(3);
    expect(e.players.map((p) => p.spec).sort()).toEqual(["105", "263", "264"]);
    expect(e.playerTeamRating).toBe(2450);
    expect(e.team1MMR).toBe(2410);
    expect(e.fileName).toBe("m1.txt");
  });
});
