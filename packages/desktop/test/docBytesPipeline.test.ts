import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { MatchStore } from "../src/main/matchStore";
import { parseDocBytes } from "../src/shared/parseDocBytes";
import { slimStoredDoc } from "../src/shared/slimDoc";
import { loadMatchFixture } from "./fixtures/loadFixture";

/** doc 字节直传端到端等价(2026-07-26 根治):
 * 新管线 = store.get() 字节 → parseDocBytes(parse + slim 兜底)
 * 旧管线 = parse 文件 → slimStoredDoc(main 侧自愈后下发的东西)
 * 两者必须 deep-equal —— 含肥档(params 未裁、crit 未物化)的情形。 */
describe("doc 字节直传管线等价", () => {
  const dir = mkdtempSync(join(tmpdir(), "gl-bytes-"));

  const putDoc = (id: string, doc: unknown) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "match.json"), JSON.stringify(doc));
    writeFileSync(
      join(dir, id, "meta.json"),
      JSON.stringify({ id, kind: "match", startTime: 1, endTime: 2 }),
    );
  };

  it("真实 fixture:get 字节 → parseDocBytes == 旧管线(parse+slim)", async () => {
    const m = loadMatchFixture();
    const doc = { schemaVersion: 1, kind: "match", data: m };
    putDoc("real1", doc);
    const s = new MatchStore(dir);
    (s as unknown as { index: Map<string, unknown> }).index.set("real1", {
      id: "real1",
      slimmed: true,
    });
    const buf = await s.get("real1");
    expect(buf).toBeInstanceOf(Buffer);
    const viaBytes = parseDocBytes(buf);
    // 旧 main 管线:parse 后过同一 slim 谓词再下发(fixture 事件带肥
    // params,谓词幂等 —— 已瘦部分零改动,肥部分两条管线裁得一样)
    const legacy = JSON.parse(
      readFileSync(join(dir, "real1", "match.json"), "utf-8"),
    );
    slimStoredDoc(legacy);
    expect(viaBytes).toEqual(legacy);
  });

  it("肥档:parseDocBytes 输出 == 旧管线(parse+slimStoredDoc)输出", async () => {
    // 造肥事件:params 14 位、无 crit(触发 crit 物化 + 裁剪)
    const m = loadMatchFixture() as unknown as {
      units: Record<string, { damageOut?: Array<Record<string, unknown>>[] }>;
    };
    const fat = JSON.parse(JSON.stringify(m));
    const anyUnit = Object.values(fat.units)[0] as {
      damageOut?: Array<Record<string, unknown>>;
    };
    anyUnit.damageOut = [
      {
        eventName: "SPELL_DAMAGE",
        timestamp: 1,
        params: Array.from({ length: 20 }, (_, i) => `p${i}`),
      },
    ];
    const doc = { schemaVersion: 1, kind: "match", data: fat };
    putDoc("fat1", doc);
    const s = new MatchStore(dir);
    (s as unknown as { index: Map<string, unknown> }).index.set("fat1", {
      id: "fat1",
      // 故意无 slimmed 标记:走肥档路径(自愈 worker 在 vitest 下优雅失败,
      // 不影响本判据 —— 消费端兜底必须独立成立)
    });
    const viaBytes = parseDocBytes(await s.get("fat1"));

    const legacy = JSON.parse(
      readFileSync(join(dir, "fat1", "match.json"), "utf-8"),
    );
    slimStoredDoc(legacy); // 旧 main 管线的自愈
    expect(viaBytes).toEqual(legacy);
    // 且确实发生了裁剪(params ≤13 位、首位空串)
    const e = (
      (viaBytes as { data: typeof fat }).data.units[
        Object.keys(fat.units)[0]!
      ] as { damageOut: Array<{ params: string[] }> }
    ).damageOut[0]!;
    expect(e.params.length).toBeLessThanOrEqual(13);
    expect(e.params[0]).toBe("");
  });
});
