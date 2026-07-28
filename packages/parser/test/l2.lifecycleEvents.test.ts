import { GladLogParser } from "../src/api";

function line(i: number, s: string): string {
  return `6/30/2026 12:00:${String(i).padStart(2, "0")}.000  ${s}`;
}
const CAST =
  'SPELL_CAST_SUCCESS,Player-1-A,"Alice-X",0x512,0x80000000,0000000000000000,nil,0x80000000,0x80000000,2983,"Sprint",0x1,Player-1-A,0000000000000000,100,100,0,0,0,0,0,0,3,10,10,0,1.00,-1.00,0,1.0,70';

function collect(p: GladLogParser) {
  const opens: unknown[] = [];
  const closes: unknown[] = [];
  p.on("segmentOpen", (i) => opens.push(i));
  p.on("segmentClose", (i) => closes.push(i));
  return { opens, closes };
}

describe("segment lifecycle events", () => {
  it("match:START 发 open(带 bracket/时间),END 发 close", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens, closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ bracket: "3v3", zoneId: "1825" });
    expect(typeof (opens[0] as { startTime: number }).startTime).toBe("number");
    expect(closes).toHaveLength(0);
    p.push(line(1, CAST));
    p.push(line(2, "ARENA_MATCH_END,1,30,1500,1501"));
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ aborted: false });
    expect((closes[0] as { endTime: number }).endTime).toBeGreaterThan(
      (opens[0] as { startTime: number }).startTime,
    );
  });

  it("shuffle:整个 lobby 只 open/close 各一次", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens, closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0"));
    p.push(line(1, CAST));
    p.push(line(2, "ARENA_MATCH_START,1504,40,Rated Solo Shuffle,0"));
    p.push(line(3, CAST));
    p.push(line(4, "ARENA_MATCH_END,1,30,1500,1501"));
    expect(opens).toHaveLength(1);
    expect(closes).toHaveLength(1);
  });

  it("end() 异常闭合 → aborted close;IDLE 时 end() 不发", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { closes } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.end();
    expect(closes).toEqual([{ endTime: null, aborted: true }]);
    const q = new GladLogParser({ timezone: "UTC" });
    const c2 = collect(q);
    q.end();
    expect(c2.closes).toHaveLength(0);
  });

  it("DOUBLE_START 不重复发 open", () => {
    const p = new GladLogParser({ timezone: "UTC" });
    const { opens } = collect(p);
    p.push(line(0, "ARENA_MATCH_START,1825,41,3v3,1"));
    p.push(line(1, "ARENA_MATCH_START,1825,41,3v3,1"));
    expect(opens).toHaveLength(1);
  });
});
