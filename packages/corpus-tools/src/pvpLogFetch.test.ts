import { describe, expect, it } from "vitest";

import type { DetailedMatchStub } from "./feedClient";
import {
  buildCompQueryString,
  buildGcsMeta,
  checkPayloadCompleteness,
  dedupeByLogObject,
  expectedByteLength,
  type ManifestEntry,
  matchesSpecFilter,
  parseSpecArg,
  stubToManifestEntry,
  upsertManifestEntry,
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

// ── 下载完整性(audit Critical:HTTP 200 但连接中途断流的截断 log 曾能不受阻拦地
// 进入 manifest + resume dedup 集合,一旦记进去就永久跳过,而 feed stub 只留 ~7 天,
// 过期后再也补不回来)────────────────────────────────────────────────────────
describe("expectedByteLength", () => {
  it("prefers x-goog-stored-content-length over content-length", () => {
    expect(
      expectedByteLength({
        contentLength: "999",
        storedContentLength: "12345",
      }),
    ).toBe(12345);
  });
  it("falls back to content-length when stored-content-length absent", () => {
    expect(expectedByteLength({ contentLength: "4096" })).toBe(4096);
  });
  it("returns undefined when neither header is present (don't misjudge missing as truncated)", () => {
    expect(expectedByteLength({})).toBeUndefined();
  });
  it("returns undefined on garbage/non-numeric header values", () => {
    expect(
      expectedByteLength({ contentLength: "not-a-number" }),
    ).toBeUndefined();
  });
});

// ── gcsMeta 空 header 容错(audit Important:缺失的 x-goog-meta-* 曾静默写成
// ""，对将来的绝对时间重建消费者是无信号的地雷——"确认为空"和"没采到"长得
// 一样)。────────────────────────────────────────────────────────────────
describe("buildGcsMeta", () => {
  it("keeps all four fields when every header is present", () => {
    const { meta, missingFields } = buildGcsMeta({
      wowVersion: "11.0.5",
      clientTimezone: "-05:00",
      clientYear: "2026",
      startTimeUtc: "1785365331361",
    });
    expect(meta).toEqual({
      wowVersion: "11.0.5",
      clientTimezone: "-05:00",
      clientYear: "2026",
      startTimeUtc: "1785365331361",
    });
    expect(missingFields).toEqual([]);
  });

  it('omits empty-string fields from meta instead of writing them as "" and reports them as missing', () => {
    const { meta, missingFields } = buildGcsMeta({
      wowVersion: "11.0.5",
      clientTimezone: "",
      clientYear: "",
      startTimeUtc: "1785365331361",
    });
    expect(meta).toEqual({
      wowVersion: "11.0.5",
      startTimeUtc: "1785365331361",
    });
    expect("clientTimezone" in meta).toBe(false);
    expect("clientYear" in meta).toBe(false);
    expect(missingFields).toEqual(["clientTimezone", "clientYear"]);
  });

  it("reports all four as missing when every header is absent", () => {
    const { meta, missingFields } = buildGcsMeta({
      wowVersion: "",
      clientTimezone: "",
      clientYear: "",
      startTimeUtc: "",
    });
    expect(meta).toEqual({});
    expect(missingFields).toEqual([
      "wowVersion",
      "clientTimezone",
      "clientYear",
      "startTimeUtc",
    ]);
  });
});

describe("checkPayloadCompleteness", () => {
  const complete =
    "ARENA_MATCH_START,1505,41,3v3,1\n...\nARENA_MATCH_END,0,30,1500,1501\n";

  it("passes a complete payload (START + END, matching byte length)", () => {
    const bytes = Buffer.byteLength(complete, "utf8");
    expect(checkPayloadCompleteness(complete, bytes)).toEqual({ ok: true });
  });

  it("passes when no expected byte length is available (header-less fetch mock)", () => {
    expect(checkPayloadCompleteness(complete, undefined)).toEqual({ ok: true });
  });

  // 红→绿的核心回归案例:修复前的判据只查 ARENA_MATCH_START,这类 START-only
  // 截断(连接中途断流)会被判定为"完整"、写盘、进 manifest、进 dedup 集合。
  it("fails a START-only truncation (the bug this fix closes)", () => {
    const truncated =
      "ARENA_MATCH_START,1505,41,3v3,1\n...(cut off mid-transfer)";
    const result = checkPayloadCompleteness(truncated, undefined);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ARENA_MATCH_END/);
  });

  it("fails when ARENA_MATCH_START itself is missing", () => {
    const result = checkPayloadCompleteness(
      "garbage, no sentinels here",
      undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ARENA_MATCH_START/);
  });

  it("fails on content-length mismatch even when both sentinels are textually present", () => {
    // 罕见但可能:截断点恰好落在两个哨兵之间,再拼上另一份 log 的尾巴——子串判据
    // 骗得过,字节数骗不过。
    const result = checkPayloadCompleteness(complete, 999999);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/byte length mismatch/);
  });

  // Solo Shuffle:6 轮共用一个 log 对象,但 segmenter.ts 实证——轮次切换只发新的
  // ARENA_MATCH_START,只有整场结束才发唯一一次 ARENA_MATCH_END。完整 SS payload
  // 与普通对局同构,判据不必(也不应该)按 bracket 分支放宽。
  it("requires ARENA_MATCH_END for a complete Solo Shuffle payload too (6 rounds, 1 END)", () => {
    const round = (n: number) =>
      `ARENA_MATCH_START,${1000 + n},41,Rated Solo Shuffle,0\n...\n`;
    const completeShuffle =
      Array.from({ length: 6 }, (_, i) => round(i)).join("") +
      "ARENA_MATCH_END,0,30,1500,1501\n";
    expect(checkPayloadCompleteness(completeShuffle, undefined)).toEqual({
      ok: true,
    });

    // 断在第 4 轮开头之后、整场收尾的 END 之前——真实的中途断流场景
    const truncatedShuffle = Array.from({ length: 4 }, (_, i) => round(i)).join(
      "",
    );
    const truncatedResult = checkPayloadCompleteness(
      truncatedShuffle,
      undefined,
    );
    expect(truncatedResult.ok).toBe(false);
    expect(truncatedResult.reason).toMatch(/ARENA_MATCH_END/);
  });
});

describe("upsertManifestEntry", () => {
  const entry = (id: string, fileName: string): ManifestEntry => ({
    ...stubToManifestEntry(stub({ id }), fileName),
  });

  it("appends when the id is new", () => {
    const manifest: ManifestEntry[] = [entry("m1", "m1.txt")];
    upsertManifestEntry(manifest, entry("m2", "m2.txt"));
    expect(manifest.map((e) => e.id)).toEqual(["m1", "m2"]);
  });

  // audit Important:文件被手动删除但 manifest 行残留时,重下会 blind-push 出
  // 同 id 的第二条记录;upsert 必须原地替换,不能重复。
  it("replaces the existing entry instead of duplicating when the id repeats", () => {
    const manifest: ManifestEntry[] = [entry("m1", "m1.txt")];
    upsertManifestEntry(manifest, entry("m1", "m1-redownloaded.txt"));
    expect(manifest).toHaveLength(1);
    expect(manifest[0].fileName).toBe("m1-redownloaded.txt");
  });

  it("mutates the array in place and also returns it", () => {
    const manifest: ManifestEntry[] = [];
    const returned = upsertManifestEntry(manifest, entry("m1", "m1.txt"));
    expect(returned).toBe(manifest);
    expect(manifest).toHaveLength(1);
  });
});
