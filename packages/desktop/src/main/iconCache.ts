import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ensureDirSync } from "fs-extra";

/**
 * 创建图标缓存服务。
 *
 * - 缓存目录由调用方传入（生产环境为 app.getPath('userData')/icons，见 main/index.ts）。
 * - 文件按图标名落盘为 <name>.jpg，无驱逐策略（磁盘缓存永久保留，靠图标集有限天然有界）。
 * - 会话级 fetch 预算默认 512，失败名单 failed 为会话级 memo，均不跨会话持久。
 */
export function createIconCache(deps: {
  cacheDir: string;
  fetchImpl?: typeof fetch;
  maxFetchesPerSession?: number;
  /**
   * 离线模式:不发任何网络请求,缓存未命中一律返回 null。
   *
   * 视觉回归专用。qa/support/stubExternal 用 Playwright 的 page.route 把渲染
   * 进程的外部请求钉成固定桩件,但**拦不到主进程** —— 图标取图在这里发,
   * 于是「拉到了就画、没拉到就不画」的抖动从 stubExternal 底下漏了过去
   * (2026-07-20 那次 2286px 的随机红灯就是同类成因)。离线模式让基线在
   * 图标这件事上恒定走 fallback,拿掉这个变量。
   */
  offline?: boolean;
}): {
  get(iconName: string): Promise<string | null>;
} {
  const failed = new Set<string>();
  const fetchFn = deps.fetchImpl ?? fetch;
  // 会话级网络预算:防被攻陷的 renderer 用海量名字打穿内存/磁盘(终审 F5)。
  // 正常战报的图标数远低于此;缓存命中不计入预算。
  const maxFetches = deps.maxFetchesPerSession ?? 512;
  let fetches = 0;

  return {
    async get(iconName: string): Promise<string | null> {
      if (!/^[a-z0-9_-]+$/i.test(iconName)) {
        return null;
      }
      if (failed.has(iconName)) {
        return null;
      }

      const filePath = join(deps.cacheDir, `${iconName}.jpg`);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath);
          return "data:image/jpeg;base64," + content.toString("base64");
        } catch {
          // Fall through to fetch
        }
      }

      // 离线模式在磁盘缓存**之后**判:已落盘的图仍可用(缓存目录在 E2E 下是
      // 临时空目录,所以实际效果就是全部走 fallback),只是绝不发起网络请求。
      if (deps.offline || fetches >= maxFetches) {
        return null;
      }
      try {
        fetches++;
        const url = `https://wow.zamimg.com/images/wow/icons/large/${iconName}.jpg`;
        const res = await fetchFn(url);
        if (!res.ok) {
          failed.add(iconName);
          return null;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        ensureDirSync(deps.cacheDir);
        writeFileSync(filePath, buffer);
        return "data:image/jpeg;base64," + buffer.toString("base64");
      } catch {
        failed.add(iconName);
        return null;
      }
    },
  };
}
