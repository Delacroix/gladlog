import type { ReactNode } from "react";

import {
  OBSERVED_SPELL_IDS,
  SPELL_NAMES_ZH_GENERATED,
  englishNameIndex,
} from "@gladlog/analysis";

import { SPEC_ID_BY_EN, SPEC_NAMES_ZH } from "../data/specNames";
import { SpecInline, SpellInline } from "../components/SpellInline";
import type { ReportSource } from "./types";

export interface RichDeps {
  /** 英文技能名→候选 id(升序);null=12MB 表未载完,整段降级原样。 */
  nameIndex: ReadonlyMap<string, readonly string[]> | null;
  zhNames: Record<string, string>;
  observed: ReadonlySet<string>;
  specByName: Record<string, number>;
  specZh: Record<string, string>;
}

const defaultDeps = (): RichDeps => ({
  nameIndex: englishNameIndex(),
  zhNames: SPELL_NAMES_ZH_GENERATED,
  observed: OBSERVED_SPELL_IDS,
  specByName: SPEC_ID_BY_EN,
  specZh: SPEC_NAMES_ZH,
});

type Entry =
  | { name: string; kind: "spell"; ids: readonly string[] }
  | { name: string; kind: "spec"; specId: number };

const ASCII = /[A-Za-z]/;
const firstToken = (s: string): string => /^[A-Za-z']+/.exec(s)?.[0] ?? "";

/** 首词→候选条目(桶内名长降序=最长匹配优先)。索引是 analysis 侧单例,
 * 以其身份缓存整张桶表(每次 makeRichText 重建 41k 桶不划算)。 */
let bucketCache: {
  idx: RichDeps["nameIndex"];
  map: Map<string, Entry[]>;
} | null = null;
function entryBuckets(deps: RichDeps): Map<string, Entry[]> | null {
  if (!deps.nameIndex) return null;
  if (bucketCache && bucketCache.idx === deps.nameIndex) return bucketCache.map;
  const m = new Map<string, Entry[]>();
  const add = (e: Entry) => {
    const k = firstToken(e.name);
    if (!k) return;
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  };
  for (const [name, ids] of deps.nameIndex) add({ name, kind: "spell", ids });
  for (const [name, specId] of Object.entries(deps.specByName))
    add({ name, kind: "spec", specId });
  for (const arr of m.values())
    arr.sort((a, b) => b.name.length - a.name.length);
  bucketCache = { idx: deps.nameIndex, map: m };
  return m;
}

export interface MatchSpellIndex {
  ids: ReadonlySet<string>;
  logNames: ReadonlyMap<string, string>;
}

/** 本场 spellId→日志名(CN 日志=中文名)。五类事件数组全 ?? []:
 * 裁剪 fixture 会剥数组(toLegacySafe 同款教训),缺面绝不能抛。 */
export function buildMatchSpellIndex(source: ReportSource): MatchSpellIndex {
  const ids = new Set<string>();
  const logNames = new Map<string, string>();
  type Ev = { spellId?: number | string; spellName?: string };
  type UnitLike = Partial<
    Record<"casts" | "petCasts" | "damageOut" | "healOut" | "auraEvents", Ev[]>
  >;
  const eat = (evs?: Ev[]) => {
    for (const e of evs ?? []) {
      if (e.spellId == null) continue;
      const id = String(e.spellId);
      ids.add(id);
      if (e.spellName && !logNames.has(id)) logNames.set(id, e.spellName);
    }
  };
  for (const u of Object.values(source.units ?? {}) as UnitLike[]) {
    eat(u.casts);
    eat(u.petCasts);
    eat(u.damageOut);
    eat(u.healOut);
    eat(u.auraEvents);
  }
  return { ids, logNames };
}

interface Ctx {
  match: MatchSpellIndex;
  lang: "zh" | "en";
  deps: RichDeps;
}

function renderEntry(
  e: Entry,
  original: string,
  ctx: Ctx,
  key: number,
): ReactNode {
  if (e.kind === "spec") {
    const display =
      ctx.lang === "zh" ? (ctx.deps.specZh[e.name] ?? original) : original;
    return (
      <SpecInline
        key={key}
        specId={e.specId}
        display={display}
        original={original}
      />
    );
  }
  const id =
    e.ids.find((x) => ctx.match.ids.has(x)) ??
    e.ids.find((x) => ctx.deps.observed.has(x)) ??
    e.ids[0]!;
  const display =
    ctx.lang === "zh"
      ? (ctx.match.logNames.get(id) ?? ctx.deps.zhNames[id] ?? original)
      : original;
  return (
    <SpellInline key={key} spellId={id} display={display} original={original} />
  );
}

function renderRichText(text: string, ctx: Ctx): ReactNode {
  const buckets = entryBuckets(ctx.deps);
  if (!buckets) return text;
  const out: ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  let key = 0;
  while (i < text.length) {
    // 只在 ASCII 单词起点尝试(前一字符不是 ASCII 字母;CJK 邻接天然是起点)
    if (!ASCII.test(text[i]!) || (i > 0 && ASCII.test(text[i - 1]!))) {
      i++;
      continue;
    }
    const token = firstToken(text.slice(i, i + 48));
    let hit: Entry | null = null;
    for (const e of buckets.get(token) ?? []) {
      if (!text.startsWith(e.name, i)) continue;
      const after = text[i + e.name.length];
      if (after === undefined || !ASCII.test(after)) {
        hit = e;
        break; // 桶内名长降序 → 首个命中即最长
      }
    }
    if (!hit) {
      i += token.length || 1;
      continue;
    }
    if (plainStart < i) out.push(text.slice(plainStart, i));
    out.push(renderEntry(hit, text.slice(i, i + hit.name.length), ctx, key++));
    i += hit.name.length;
    plainStart = i;
  }
  if (out.length === 0) return text; // 无命中:原字符串直返(=== 短路)
  if (plainStart < text.length) out.push(text.slice(plainStart));
  return out;
}

/** 每场/每语言构建一次(接入点 useMemo),返回的渲染函数按段调用。 */
export function makeRichText(
  source: ReportSource,
  lang: "zh" | "en",
  deps: RichDeps = defaultDeps(),
): (text?: string | null) => ReactNode {
  const match = buildMatchSpellIndex(source);
  return (text) =>
    text ? renderRichText(text, { match, lang, deps }) : (text ?? null);
}
