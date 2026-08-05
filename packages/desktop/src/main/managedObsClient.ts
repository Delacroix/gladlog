import OBSWebSocket from "obs-websocket-js";

/**
 * obs-websocket-js 的最小面(复核 I3):`managedObsBackend.ts` 只需要
 * connect/call/on/disconnect 四个动词,窄接口让 fake 好写、行为好断言(尤其是
 * "事件监听必须在 StartRecord 之前挂好"这条顺序要求)。
 *
 * 故意不提供退订(`off`)——真实的 obs-websocket-js 客户端在这四个方法里也没有
 * 对称的取消订阅原语给我们包一层;`managedObsBackend.ts` 的监听器本来就是常驻的
 * (整个托管会话期间只挂一次),不需要它。`CaptureBackend.onChunkOpened` 的退订
 * 是backend 自己在应用层维护的回调集合,与这里的 websocket 事件订阅是两回事。
 */
export interface ManagedObsWs {
  connect(url: string, password: string): Promise<void>;
  call(
    req: string,
    data?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  on(event: string, cb: (data: Record<string, unknown>) => void): void;
  disconnect(): Promise<void>;
}

export function realManagedObsWs(): ManagedObsWs {
  const obs = new OBSWebSocket();
  return {
    async connect(url, password) {
      await obs.connect(url, password);
    },
    // The real obs-websocket-js `call` is generic over a request-type union
    // keyed by request name; managedObsBackend deliberately narrows to plain
    // strings (design doc source-level facts are cited by request NAME, not
    // by TS overload), so the cast here is the one place that boundary is
    // crossed.
    async call(req, data) {
      return (await (
        obs as unknown as {
          call: (
            r: string,
            d?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
        }
      ).call(req, data)) as Record<string, unknown>;
    },
    on(event, cb) {
      (
        obs as unknown as {
          on: (e: string, c: (d: Record<string, unknown>) => void) => void;
        }
      ).on(event, cb);
    },
    async disconnect() {
      await obs.disconnect();
    },
  };
}
