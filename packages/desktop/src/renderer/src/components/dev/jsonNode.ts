/**
 * 开发者页 JSON 检查器的纯逻辑层(方案 5a 三点七)。
 *
 * 唯一的硬约束:**只序列化展开的节点**。库内 match.json 均值 ≈62MB
 * (794 场 / 49GB),旧实现 `JSON.stringify(整份 doc)` 后灌 <pre>,渲染进程
 * 直接冻死(2026-07-26 实测 30s 无响应)。这里的每个函数都按「一层」工作:
 * 列子节点只碰当前层的直接子值,容器子节点只取规模摘要(`.length` /
 * `Object.keys`),绝不下探。测试用访问计数(Proxy)钉死这条契约。
 */

export type JsonNodeKind =
  "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonChild {
  /** 对象键名,或数组下标的十进制串 */
  key: string;
  /** 从根算起的完整 key path,可回喂 resolvePath */
  path: string;
  value: unknown;
  kind: JsonNodeKind;
  /** 叶子的行内展示文本(已封顶);容器为 null */
  preview: string | null;
  /** 容器的规模摘要(`[1000]` / `{12}`);叶子为 null */
  summary: string | null;
}

export interface ChildPage {
  children: JsonChild[];
  /** 该容器的子节点总数(不受分页影响) */
  total: number;
  /** 总页数,对象恒为 1 */
  pages: number;
  /** 实际生效的页码(越界入参会被夹到末页) */
  page: number;
}

/** 数组每页条数:5 万条 casts 一次性铺进 DOM 就是另一种冻死。 */
export const ARRAY_PAGE_SIZE = 500;

/** 叶子行内预览的字符上限。 */
export const LEAF_PREVIEW_CAP = 200;

/** 键名搜索的节点预算:全图遍历一份 62MB doc 是秒级长任务,必须有上限。 */
export const SEARCH_NODE_BUDGET = 200_000;

/** 单次搜索最多回报的命中数。 */
export const SEARCH_HIT_CAP = 50;

export function kindOf(v: unknown): JsonNodeKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  // undefined / function / symbol 不出现在 JSON.parse 的产物里,归到 null 显示
  return "null";
}

export function isContainer(kind: JsonNodeKind): boolean {
  return kind === "object" || kind === "array";
}

/** 叶子的行内文本。超长字符串截断并标注原长 —— 单个 raw 字段就能有几十 KB。 */
export function leafPreview(v: unknown, cap = LEAF_PREVIEW_CAP): string {
  if (typeof v === "string" && v.length > cap) {
    return `${JSON.stringify(v.slice(0, cap))}… (${v.length} 字符)`;
  }
  const s = JSON.stringify(v);
  return s === undefined ? "null" : s;
}

/** 容器的规模摘要。只读 length / keys,不下探元素。 */
function containerSummary(v: unknown, kind: JsonNodeKind): string {
  if (kind === "array") return `[${(v as unknown[]).length}]`;
  return `{${Object.keys(v as object).length}}`;
}

function joinPath(base: string, key: string, parentIsArray: boolean): string {
  if (parentIsArray) return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function toChild(
  key: string,
  value: unknown,
  base: string,
  parentIsArray: boolean,
): JsonChild {
  const kind = kindOf(value);
  const container = isContainer(kind);
  return {
    key,
    path: joinPath(base, key, parentIsArray),
    value,
    kind,
    preview: container ? null : leafPreview(value),
    summary: container ? containerSummary(value, kind) : null,
  };
}

/**
 * 列出 `value` 这一层的子节点。数组分页(每页 ARRAY_PAGE_SIZE),对象不分页。
 * 非容器返回空页。
 */
export function childrenOf(
  value: unknown,
  basePath: string,
  page = 0,
): ChildPage {
  const kind = kindOf(value);
  if (kind === "array") {
    const arr = value as unknown[];
    const total = arr.length;
    const pages = Math.max(1, Math.ceil(total / ARRAY_PAGE_SIZE));
    const p = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
    const from = p * ARRAY_PAGE_SIZE;
    const to = Math.min(total, from + ARRAY_PAGE_SIZE);
    const children: JsonChild[] = [];
    for (let i = from; i < to; i++) {
      children.push(toChild(String(i), arr[i], basePath, true));
    }
    return { children, total, pages, page: p };
  }
  if (kind === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      children: entries.map(([k, v]) => toChild(k, v, basePath, false)),
      total: entries.length,
      pages: 1,
      page: 0,
    };
  }
  return { children: [], total: 0, pages: 1, page: 0 };
}

/** `a.b[2].c` → ["a","b","2","c"];空串 → []。 */
function splitPath(path: string): string[] {
  const out: string[] = [];
  const re = /([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) out.push(m[1]!);
  return out;
}

/** 逐段解析 key path。任一段不存在 → ok:false(越界下标也算不存在)。 */
export function resolvePath(
  root: unknown,
  path: string,
): { ok: boolean; value: unknown } {
  let cur = root;
  for (const seg of splitPath(path)) {
    const kind = kindOf(cur);
    if (kind === "array") {
      const i = Number(seg);
      const arr = cur as unknown[];
      if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
        return { ok: false, value: undefined };
      }
      cur = arr[i];
    } else if (kind === "object") {
      const obj = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
        return { ok: false, value: undefined };
      }
      cur = obj[seg];
    } else {
      return { ok: false, value: undefined };
    }
  }
  return { ok: true, value: cur };
}

/**
 * 命中路径的全部祖先(不含自身),按从浅到深排序 —— 树用它逐级展开到命中处。
 * `rounds[0].deaths` → ["rounds", "rounds[0]"]。
 */
export function ancestorPaths(path: string): string[] {
  const out: string[] = [];
  const re = /(\.[^.[\]]+|\[[0-9]+\]|^[^.[\]]+)/g;
  let m: RegExpExecArray | null;
  let acc = "";
  const parts: string[] = [];
  while ((m = re.exec(path)) !== null) parts.push(m[1]!);
  for (let i = 0; i < parts.length - 1; i++) {
    acc += parts[i];
    out.push(acc);
  }
  return out;
}

export interface KeySearchResult {
  paths: string[];
  /** 实际访问的节点数 */
  scanned: number;
  /** 因节点预算或命中上限而未扫全 */
  truncated: boolean;
}

/**
 * 按键名子串搜索,返回命中节点的完整路径。
 *
 * 预算是硬的:遍历一份 62MB doc 的全部节点是秒级长任务,会把渲染主线程占死
 * ——正是本次改版要根治的病。到达 SEARCH_NODE_BUDGET 即停,并如实标注截断。
 */
export function searchKeyPaths(
  root: unknown,
  query: string,
  budget = SEARCH_NODE_BUDGET,
  hitCap = SEARCH_HIT_CAP,
): KeySearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { paths: [], scanned: 0, truncated: false };

  const paths: string[] = [];
  let scanned = 0;
  let overflowed = false;

  const walk = (node: unknown, base: string): void => {
    if (scanned >= budget) return;
    const kind = kindOf(node);
    if (!isContainer(kind)) return;
    const isArr = kind === "array";
    const entries: Array<[string, unknown]> = isArr
      ? (node as unknown[]).map((v, i) => [String(i), v])
      : Object.entries(node as Record<string, unknown>);
    for (const [k, v] of entries) {
      if (scanned >= budget) return;
      scanned++;
      const path = joinPath(base, k, isArr);
      // 数组下标不参与键名匹配:搜 "0" 命中全部数组首元素毫无意义
      if (!isArr && k.toLowerCase().includes(q)) {
        if (paths.length < hitCap) paths.push(path);
        else overflowed = true;
      }
      walk(v, path);
    }
  };

  walk(root, "");
  return { paths, scanned, truncated: overflowed || scanned >= budget };
}

/** 「复制当前节点」用:单节点 pretty JSON。调用点自负体积(只给展开的节点)。 */
export function stringifyNode(v: unknown): string {
  return JSON.stringify(v, null, 2) ?? "null";
}
