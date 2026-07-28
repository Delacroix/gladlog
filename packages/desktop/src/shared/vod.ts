/** vod:// 供片协议的纯函数部分(electron-free,可单测)。
 * token 放 path 段而非 host —— Chrome 会把 host 规范化成小写,base64url
 * 串会因此损坏;path 段保真。 */
export const VOD_SCHEME = "vod";

export function vodUrl(path: string): string {
  return `${VOD_SCHEME}://v/${Buffer.from(path, "utf-8").toString("base64url")}`;
}

export function vodUrlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== `${VOD_SCHEME}:`) return null;
    const token = u.pathname.replace(/^\//, "");
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    return Buffer.from(token, "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

/** HTTP Range 单段解析;无/非法 → null(调用方整文件 200)。 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === "" && e === "") return null;
  if (s === "") {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(s!);
  const end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}
