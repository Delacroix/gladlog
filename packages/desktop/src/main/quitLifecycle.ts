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
  /**
   * 通常是 `() => stopAllAiActivity()`(ai.ts):收掉飞行中的本地 CLI
   * 子进程(claude/agy/codex spawn)与 DeepSeek fetch。#21 item9,完整性
   * 修复,非既有 bug——宿主进程退出后这些连接本就会自然断/变孤儿。
   * 可选(省略等于不做);fire-and-forget,不参与下方 timeoutMs 的封顶
   * race——这是同步调用,没有需要等待的异步尾巴。
   */
  stopAiActivity?: () => void;
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
    // fire-and-forget,同 stopHost 的兜底模式:不参与下面的 timeoutMs 封顶
    // race(同步调用,没有异步尾巴要等),失败也不能拖累退出流程。
    try {
      deps.stopAiActivity?.();
    } catch {
      // 尽力而为:退出流程不能因为这里报错而卡住。
    }
    const timeoutMs = deps.timeoutMs ?? 4000;
    await Promise.race([
      deps.stopRecorder().catch(() => {
        /* 尽力而为:退出流程不能因为 OBS 报错而卡住 */
      }),
      new Promise<void>((res) => setTimeout(res, timeoutMs)),
    ]);
    try {
      deps.stopHost();
    } catch {
      // 复核轮抓回:stopHost 是同步调用,不像 stopRecorder 有 .catch 兜底,
      // 同步抛出会让 finish() 直接 reject——没有生产环境 catch 者接手,
      // 变成 unhandled rejection,还会让下面的 quit() 永远不会被调用
      // (退出流程比修复前更糟)。尽力而为,不让它拖累退出。
    }
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
