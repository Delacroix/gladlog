/**
 * 对局文档脱敏(导出 fixture 用)。
 *
 * 两个消费者:开发者页右栏「导出脱敏 fixture」与 `scripts/make-report-fixture.mjs`。
 * 按 CLAUDE.md 的谓词单源规则,两边 import 同一个函数 —— 各写一份的代价是
 * 哪天一边漏改就把真玩家名提交进仓库(`test/anonymizeFixture.test.ts` 里有
 * 一条断言脚本确实在 import 本模块)。
 *
 * 替换在**序列化后的文本**上做,不是逐字段改:真名会出现在 deaths.victim、
 * 事件的 source/target、宠物 owner 等一堆地方,只改 units[].name 等于没脱敏。
 */

/** Name-Realm → PlayerA-Test。超过 26 人接数字后缀,保证不撞。 */
function aliasFor(i: number): string {
  const letter = String.fromCharCode(65 + (i % 26));
  const round = Math.floor(i / 26);
  return round === 0 ? `Player${letter}-Test` : `Player${letter}${round}-Test`;
}

interface UnitLike {
  kind?: string;
  name?: string;
}
interface DocLike {
  units?: Record<string, UnitLike>;
  rounds?: Array<{ units?: Record<string, UnitLike> }>;
}

/** 收集全文档(含 shuffle 各轮)的 Player 真名 → 别名映射。 */
export function playerAliasMap(doc: unknown): Record<string, string> {
  const d = (doc ?? {}) as DocLike;
  const unitSets: Array<Record<string, UnitLike> | undefined> = [d.units];
  if (Array.isArray(d.rounds))
    for (const r of d.rounds) unitSets.push(r?.units);

  const names: string[] = [];
  for (const set of unitSets) {
    if (!set) continue;
    for (const u of Object.values(set)) {
      if (u?.kind !== "Player") continue;
      const n = u.name;
      if (typeof n !== "string" || !n || names.includes(n)) continue;
      names.push(n);
    }
  }
  // 长名先替换:短名是长名子串时(Bob 与 Bobby)先换短的会把长名切碎
  const order = [...names].sort((a, b) => b.length - a.length);
  const aliasByName: Record<string, string> = {};
  names.forEach((n, i) => (aliasByName[n] = aliasFor(i)));
  const out: Record<string, string> = {};
  for (const n of order) out[n] = aliasByName[n]!;
  return out;
}

/** 递归剥掉 rawLines(原始日志行整行含真名与账号信息)。 */
function stripRawLines(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRawLines);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "rawLines") continue;
      out[k] = stripRawLines(val);
    }
    return out;
  }
  return v;
}

export interface AnonymizeResult {
  /** 脱敏后的 JSON 文本(缩进 1,与既有 fixture 一致) */
  text: string;
  /** 被替换的玩家数 */
  players: number;
}

export interface AnonymizeOptions {
  /** 保留真名(仅用于 gitignored 的本地压测样本:CN/特殊字符原名本身就是
   *  渲染边界测试对象)。rawLines 照剥不误。 */
  keepNames?: boolean;
}

export function anonymizeMatchDoc(
  doc: unknown,
  opts: AnonymizeOptions = {},
): AnonymizeResult {
  const aliases = opts.keepNames ? {} : playerAliasMap(doc);
  let text = JSON.stringify(stripRawLines(doc), null, 1);
  for (const [name, alias] of Object.entries(aliases)) {
    // 在 JSON 文本里替换的是转义后的字面量(名字含 " 或 \ 时才有差别)
    const literal = JSON.stringify(name).slice(1, -1);
    text = text.split(literal).join(alias);
  }
  return { text, players: Object.keys(aliases).length };
}
