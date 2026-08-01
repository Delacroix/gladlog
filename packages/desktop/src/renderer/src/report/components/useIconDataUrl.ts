import { useEffect, useState } from "react";

import { bridge } from "../../bridge";

// 同名 icon 只发一次 IPC(泳道一场几百 chip;bridge 侧有磁盘缓存,这层防
// round-trip 抖动)。Promise 缓存:并发请求共享同一 in-flight。
// 有界(LRU 语义的插入序驱逐):base64 data URL ~25KB/个,长会话跨几百场
// 无界攒到 20-40MB 只增不减(2026-07-26 审计);单场不同图标至多几百个,
// 512 覆盖 2-3 场热集,溢出的最旧项重取一次 IPC 即可(main 侧有磁盘缓存)。
const ICON_MEMO_MAX = 512;
const iconMemo = new Map<string, Promise<string | null>>();

export function getIconCached(icon: string): Promise<string | null> {
  const hit = iconMemo.get(icon);
  if (hit) {
    iconMemo.delete(icon);
    iconMemo.set(icon, hit); // LRU touch
    return hit;
  }
  const b = bridge();
  const p =
    b && b.icon ? b.icon.get(icon) : Promise.resolve<string | null>(null);
  iconMemo.set(icon, p);
  while (iconMemo.size > ICON_MEMO_MAX) {
    const oldest = iconMemo.keys().next().value!;
    iconMemo.delete(oldest);
  }
  return p;
}

/**
 * 图标基名 → data URL。取不到(无 bridge / 主进程取图失败 / 未知图标)一律
 * 返回 null,由调用方决定回退长什么样 —— 技能 chip 回退首字母、对局列表回退
 * 职业色字形点,两者外观不同,所以共享的是取图逻辑而不是整个组件。
 */
export function useIconDataUrl(icon: string | null | undefined): {
  dataUrl: string | null;
  loading: boolean;
} {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!icon);

  useEffect(() => {
    if (!icon) {
      setDataUrl(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let active = true;
    getIconCached(icon)
      .then((url) => {
        if (active) {
          setDataUrl(url);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setDataUrl(null);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [icon]);

  return { dataUrl, loading };
}

/**
 * 批量版:一次要多个图标时用(回放里每个单位一个专精图标、筛选条里每个已选
 * 专精一个)—— hook 不能在循环里调,所以由调用方把名字收集成数组传进来。
 * 返回 基名 → data URL 的表,取不到的键直接缺席,调用方按缺席回退。
 *
 * icons 的**内容**变了才重取:调用方通常在 render 里现拼数组,按引用比会
 * 每帧重跑 effect。
 */
export function useIconDataUrls(
  icons: (string | null | undefined)[],
): Record<string, string> {
  const names = Array.from(
    new Set(icons.filter((n): n is string => !!n)),
  ).sort();
  const key = names.join("|");
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (names.length === 0) {
      setUrls({});
      return;
    }
    let active = true;
    Promise.all(
      names.map((n) => getIconCached(n).then((u) => [n, u] as const)),
    ).then((pairs) => {
      if (!active) return;
      const next: Record<string, string> = {};
      for (const [n, u] of pairs) if (u) next[n] = u;
      setUrls(next);
    });
    return () => {
      active = false;
    };
    // key 是 names 的内容指纹;names 本身每次 render 都是新数组引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}
