/**
 * 视觉回归的外部网络隔离。
 *
 * 为什么需要:基线是像素级单源标准,而页面里曾有运行时从公网拉的资源
 * (竞技场 minimap 底图 —— arenaMaps.ts 的 wowarenalogs CDN)。拉到了就画、
 * 没拉到就不画,于是**同一份代码**在两次 CI 上能出两张不同的图。
 * 2026-07-20 的 run 29771469113 就是这么红的:report-replay 差 2286 px,
 * 下一次 push 没改任何 UI 代码又自己绿了。
 *
 * 2026-08-01 起根因被移除而不只是被遮盖:minimap 底图随包内置
 * (arenaMaps.ts 的 import.meta.glob),技能/专精图标走主进程 iconCache 且在
 * GLADLOG_E2E=1 下离线(page.route 拦不到主进程,这条只能在主进程那侧关)。
 * 页面因此**不该再请求任何外部主机**,所以这里不再为任何主机放行:一律记账
 * + abort,由用例断言账本为空。新加一个 CDN 依赖会直接把用例打红并指名道姓,
 * 而不是留一颗随机红灯。
 */
import type { Page } from "@playwright/test";

/**
 * 把 page 上所有非本机请求挡下来。返回**泄漏账本**:被挡掉的外部 URL。
 * 用例必须断言它为空 —— 账本非空 = 新增了一个会让基线随网络漂移的依赖。
 */
export async function isolateExternalRequests(page: Page): Promise<string[]> {
  const leaked: string[] = [];
  // 必须 await:route 注册本身是异步的,不等它落地就 goto 会漏掉首批请求
  // —— 那等于把「偶尔拦不住」重新引回来。
  await page.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    (route) => {
      leaked.push(route.request().url());
      return route.abort();
    },
  );
  return leaked;
}
