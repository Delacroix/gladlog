/**
 * 从暴雪官方 DB2(ChrSpecialization / ChrClasses)生成 CombatUnitSpec 与
 * CombatUnitClass。
 *
 * 为什么要生成而不是手写:这两个枚举此前是从 wowarenalogs 的
 * packages/parser/src/types.ts 逐行照搬的,而该仓整体为 CC BY-NC-ND 4.0
 * (禁商用、禁衍生),与本仓 MIT 再分发不相容。取值(specId/classId)本身是
 * 暴雪的游戏事实、不受著作权保护,受保护的是「怎么把它们排布成一份枚举」的
 * 表达——所以修法是**从官方数据独立推导**,用我们自己写死的命名规则,而不是
 * 给抄来的表加个出处注释。详见 docs/DATA-COMPLIANCE.md。
 *
 * 产物写进 packages/parser-compat/src/enumsGenerated.ts。生成器放在
 * analysis/scripts/datagen 是因为 DB2 抓取/解析的全部基础设施都在这儿
 * (lib/wagoCsv);parser-compat 不依赖 analysis,这条写入方向只在构建期成立。
 */
import { writeArtifact } from "./lib/emit";
import {
  assertColumns,
  fetchLatestBuild,
  fetchTable,
  parseCsv,
} from "./lib/wagoCsv";

/** 枚举成员名只留字母数字:"Beast Mastery" → "BeastMastery"。 */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * 玩家专精判据:ClassID≠0 排除宠物专精(凶猛/狡诈/坚韧,ClassID 恒 0),
 * OrderIndex≤3 排除每职业一条的 "Initial" 起始模板行与 ClassID=14 的
 * "Adventurer"(两者 OrderIndex 均为 4)。真实专精每职业 3 个、德鲁伊 4 个,
 * OrderIndex 恒为 0..3 —— 用序号而非名字过滤,避免被本地化文本影响。
 */
export function selectPlayerSpecs(
  specRows: Record<string, string>[],
): Record<string, string>[] {
  return specRows.filter((r) => r.ClassID !== "0" && Number(r.OrderIndex) <= 3);
}

export interface SpecEntry {
  id: string;
  member: string;
  classId: string;
}

/**
 * 命名规则(本仓自定,非沿用他处):`<职业名><下划线><专精名>`,两段各自去掉
 * 非字母数字字符,大小写一律取官方 Name_lang 原样。排序按 specId 数值升序 ——
 * 一个确定性的、跟任何既有实现无关的顺序。
 */
export function buildSpecEntries(
  specRows: Record<string, string>[],
  classRows: Record<string, string>[],
): SpecEntry[] {
  const className = new Map(classRows.map((r) => [r.ID, r.Name_lang]));
  const entries = selectPlayerSpecs(specRows).map((r) => {
    const cn = className.get(r.ClassID);
    if (!cn) {
      throw new Error(
        `spec ${r.ID} (${r.Name_lang}) references unknown ClassID ${r.ClassID}`,
      );
    }
    return {
      id: r.ID,
      member: `${sanitize(cn)}_${sanitize(r.Name_lang)}`,
      classId: r.ClassID,
    };
  });
  entries.sort((a, b) => Number(a.id) - Number(b.id));

  const seen = new Map<string, string>();
  for (const e of entries) {
    const prior = seen.get(e.member);
    if (prior) {
      // 同名成员会静默丢掉一个专精,宁可炸在生成期。
      throw new Error(
        `duplicate enum member ${e.member} for specIds ${prior} and ${e.id}`,
      );
    }
    seen.set(e.member, e.id);
  }
  return entries;
}

/**
 * 可玩职业 = 至少拥有一个玩家专精的职业,由 specs 反推而不是手写白名单 ——
 * 新职业上线时自动跟进,也不会把 Adventurer 这类非玩家条目带进来。
 * 取值直接用官方 ChrClasses.ID(暴雪事实),不再自造编号。
 */
export function buildClassEntries(
  specRows: Record<string, string>[],
  classRows: Record<string, string>[],
): { id: string; member: string }[] {
  const playable = new Set(selectPlayerSpecs(specRows).map((r) => r.ClassID));
  return classRows
    .filter((r) => playable.has(r.ID))
    .map((r) => ({ id: r.ID, member: sanitize(r.Name_lang) }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export function renderEnums(
  specs: SpecEntry[],
  classes: { id: string; member: string }[],
  build: string,
): string {
  const specLines = specs.map((e) => `  ${e.member} = "${e.id}",`).join("\n");
  const classLines = classes.map((e) => `  ${e.member} = ${e.id},`).join("\n");
  return `// 生成文件 —— 勿手改。由 packages/analysis/scripts/datagen/genCombatUnitEnums.ts
// 从暴雪 DB2(ChrSpecialization / ChrClasses)生成。
// build: ${build}
//
// specId 取值与 classId 取值均为暴雪游戏数据事实;成员命名规则见生成器文档注释。
// 重新生成:cd packages/analysis && npx tsx scripts/datagen/genCombatUnitEnums.ts

/** 专精。取值为暴雪 specId 字符串(COMBATANT_INFO 里就是这个数)。 */
export enum CombatUnitSpec {
  None = "0",
${specLines}
}

/** 职业。取值为暴雪官方 ChrClasses.ID —— 与日志里的 classId 直接同值,无需换算。 */
export enum CombatUnitClass {
  None = 0,
${classLines}
}
`;
}

export async function main(): Promise<void> {
  const build = process.env.DATAGEN_BUILD ?? (await fetchLatestBuild());
  const specCsv = parseCsv(await fetchTable("ChrSpecialization", build));
  const classCsv = parseCsv(await fetchTable("ChrClasses", build));
  assertColumns(
    specCsv.header,
    ["ID", "ClassID", "Name_lang", "OrderIndex"],
    "ChrSpecialization",
  );
  assertColumns(classCsv.header, ["ID", "Name_lang"], "ChrClasses");

  const specs = buildSpecEntries(specCsv.rows, classCsv.rows);
  const classes = buildClassEntries(specCsv.rows, classCsv.rows);

  // 下限守卫:抓空表/换列名时早炸,别把空枚举写进源码树。上限不设 ——
  // 暴雪加职业加专精是正常演进,自动跟进正是生成的意义。
  if (specs.length < 39) {
    throw new Error(`only ${specs.length} player specs parsed; expected >= 39`);
  }
  if (classes.length < 13) {
    throw new Error(`only ${classes.length} playable classes; expected >= 13`);
  }

  const out = new URL(
    "../../../parser-compat/src/enumsGenerated.ts",
    import.meta.url,
  ).pathname;
  writeArtifact(out, renderEnums(specs, classes, build));
  console.log(
    `wrote ${specs.length} specs / ${classes.length} classes (build ${build}) → ${out}`,
  );
}

// 直接执行时跑 main(被 import 做单测时不跑)——与同目录其余生成器同一守卫写法。
if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1]?.endsWith("genCombatUnitEnums.ts")
) {
  main().catch((e) => {
    console.error("genCombatUnitEnums failed:", e);
    process.exit(1);
  });
}
