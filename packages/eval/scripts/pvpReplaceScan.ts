/**
 * 替换型 PvP 天赋语料挖矿(常驻,2026-07-25):找 (pvpTalent X, 大 CD Y)
 * 满足「选 X 者 Y 的 neverUsed 率 ≈ 100%,未选 X 者显著更低」——
 * 即 PVP_TALENT_REPLACES 的实证候选。表只收挖出来的对,不凭记忆扩。
 * Usage: tsx pvpReplaceScan.ts --manifest <file> [--store <matches dir>]
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { GladLogParser, type GladMatch } from "@gladlog/parser";
import { toLegacyMatch } from "@gladlog/parser-compat";
import { extractMajorCooldowns, specToString } from "@gladlog/analysis";

type Key = string; // spec|talent|cd
const agg = new Map<Key, { pickedN: number; pickedNever: number; unpickedN: number; unpickedNever: number; cdName: string; spec: string }>();

function feed(legacy: any) {
  const players = Object.values(legacy.units ?? {}).filter((u: any) => u.info) as any[];
  for (const p of players) {
    let cds: any[] = [];
    try { cds = extractMajorCooldowns(p, legacy); } catch { continue; }
    const picked = new Set<string>((p.info?.pvpTalents ?? []).filter((t: string) => t && t !== "0"));
    // 该 spec 出现过的所有 pvp 天赋作为 X 候选(含未选的,靠聚合区分)
    for (const cd of cds) {
      for (const t of picked) {
        const k = `${p.spec}|${t}|${cd.spellId}`;
        const e = agg.get(k) ?? { pickedN: 0, pickedNever: 0, unpickedN: 0, unpickedNever: 0, cdName: cd.spellName, spec: specToString(p.spec) };
        e.pickedN++; if (cd.neverUsed) e.pickedNever++;
        agg.set(k, e);
      }
    }
    // 未选侧:同 spec 其他玩家的对照在聚合时算 —— 这里记录该玩家没选哪些
    // (对照集需要全 spec 天赋全集,扫描后再补)
    (feed as any).players = ((feed as any).players ?? []);
    (feed as any).players.push({ spec: p.spec, picked, cds: cds.map((c) => ({ id: c.spellId, name: c.spellName, never: c.neverUsed })) });
  }
}

const argv = process.argv.slice(2);
const mIdx = argv.indexOf("--manifest");
const sIdx = argv.indexOf("--store");
if (mIdx >= 0) {
  for (const f of readFileSync(argv[mIdx + 1]!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const parser = new GladLogParser();
    const items: GladMatch[] = [];
    parser.on("match", (m) => items.push(m));
    parser.on("shuffle", (s) => items.push(...(s.rounds as never[])));
    for (const line of readFileSync(f, "utf8").split("\n")) parser.push(line);
    parser.end();
    for (const m of items) { try { feed(toLegacyMatch({ ...m, rawLines: [] } as GladMatch)); } catch { /* skip */ } }
  }
}
if (sIdx >= 0) {
  const dir = argv[sIdx + 1]!;
  for (const id of readdirSync(dir)) {
    const p = join(dir, id, "match.json");
    if (!existsSync(p)) continue;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8"));
      const sources = doc.kind === "shuffle" ? doc.data.rounds : [doc.data];
      // store doc 是新 parser 形态,需要 legacy 化;直接用 parser-compat
      const { toLegacyMatch: toL } = await import("@gladlog/parser-compat");
      for (const src of sources) { try { feed(toL({ ...src, rawLines: [] })); } catch { /* skip */ } }
    } catch { /* skip */ }
  }
}

// 对照:未选 X 的同 spec 玩家里 Y 的 neverUsed 率
const players = ((feed as any).players ?? []) as { spec: string; picked: Set<string>; cds: { id: string; name: string; never: boolean }[] }[];
const talentsBySpec = new Map<string, Set<string>>();
for (const p of players) {
  const s = talentsBySpec.get(p.spec) ?? new Set();
  for (const t of p.picked) s.add(t);
  talentsBySpec.set(p.spec, s);
}
for (const p of players) {
  for (const t of talentsBySpec.get(p.spec) ?? []) {
    if (p.picked.has(t)) continue;
    for (const cd of p.cds) {
      const k = `${p.spec}|${t}|${cd.id}`;
      const e = agg.get(k);
      if (!e) continue;
      e.unpickedN++; if (cd.never) e.unpickedNever++;
    }
  }
}

console.log("疑似替换对(选X→Y全未用 ≥90%,未选X→未用率低,样本≥8):");
for (const [k, e] of [...agg.entries()].sort((a, b) => b[1].pickedN - a[1].pickedN)) {
  const [, talent, cd] = k.split("|");
  if (e.pickedN < 8 || e.unpickedN < 8) continue;
  const pr = e.pickedNever / e.pickedN;
  const ur = e.unpickedNever / e.unpickedN;
  if (pr >= 0.9 && ur <= 0.4) {
    console.log(`  ${e.spec} 天赋 ${talent} → CD ${cd} ${e.cdName}:选者未用 ${e.pickedNever}/${e.pickedN},未选者未用 ${e.unpickedNever}/${e.unpickedN}`);
  }
}
console.log("(空输出 = 语料中没有其他高置信替换对)");
