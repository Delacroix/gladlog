/** C2 修复:app 退出必须等录像真正停下(StopRecord 的异步往返),否则 OBS
 * 大概率在进程死后继续录到天荒地老。electron 的 `before-quit` 是唯一能在
 * 退出前插一脚的钩子——但它是同步事件,想让退出等一个 Promise 必须
 * `event.preventDefault()` 挂起,清理完再手动调用一次 quit()。
 *
 * 语义:
 * - 第一次 before-quit:preventDefault,启动清理(stopRecorder,封顶
 *   timeoutMs——OBS 失联/网络卡死不能把退出流程挂死),清理完调 stopHost()
 *   再调 quit()。
 * - 清理进行中如果又收到一次 before-quit(用户手贱点两次、或某些平台在
 *   window 都关掉后自己又发一次):同样 preventDefault,但不重新启动清理
 *   （不重入 —— 只有一条清理链在跑)。
 * - quit() 内部通常就是 app.quit(),会重新触发 before-quit;这次进来时
 *   清理已经跑完,直接放行(不再 preventDefault),真正退出。
 *
 * 从 index.ts 里抠出来的唯一原因是可测:真实 electron 的 app/BrowserWindow
 * 在 vitest 里没法轻量实例化,这层只依赖三个纯函数依赖,可以完全脱离
 * electron 测试。 */
export interface QuitLifecycleDeps {
  /** 通常是 `() => recorder?.stop() ?? Promise.resolve()` */
  stopRecorder: () => Promise<void>;
  /** 通常是 `() => host?.stop()` */
  stopHost: () => void;
  /** 通常是 `() => app.quit()` */
  quit: () => void;
  /** 停录卡死时的封顶等待,默认 4s(3-5s 区间,不让退出挂死)。 */
  timeoutMs?: number;
}

export interface QuitLifecycleHandler {
  /** 挂到 `app.on("before-quit", (e) => handler.onBeforeQuit(e))`。 */
  onBeforeQuit(event: { preventDefault(): void }): void;
  /** 测试专用:等清理链跑完(生产代码不需要调用)。 */
  waitForIdle(): Promise<void>;
}

export function createQuitLifecycleHandler(
  deps: QuitLifecycleDeps,
): QuitLifecycleHandler {
  type Phase = "idle" | "stopping" | "finishing";
  let phase: Phase = "idle";
  let inFlight: Promise<void> | null = null;

  async function finish(): Promise<void> {
    const timeoutMs = deps.timeoutMs ?? 4000;
    await Promise.race([
      deps.stopRecorder().catch(() => {
        /* 尽力而为:退出流程不能因为 OBS 报错而卡住 */
      }),
      new Promise<void>((res) => setTimeout(res, timeoutMs)),
    ]);
    deps.stopHost();
    // 先翻到 finishing 再喊 quit():quit() 常常同步触发下一轮
    // before-quit(比如 electron 的 app.quit()),必须在那之前就放行。
    phase = "finishing";
    deps.quit();
  }

  return {
    onBeforeQuit(event) {
      if (phase === "finishing") return; // 清理已完成,这次是真退出,放行
      event.preventDefault();
      if (phase === "idle") {
        phase = "stopping";
        inFlight = finish();
      }
      // phase === "stopping":清理还在跑,挡掉这次多余的退出请求,不重入
    },
    waitForIdle: () => inFlight ?? Promise.resolve(),
  };
}
