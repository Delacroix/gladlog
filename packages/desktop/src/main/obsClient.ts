import OBSWebSocket from "obs-websocket-js";

/** OBS 控制面收敛到最小 API,recorder 的单测全走 fake。 */
export interface ObsClientLike {
  connect(url: string, password?: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string }>;
  disconnect(): Promise<void>;
  onClosed(cb: () => void): void;
}

export function realObsClient(): ObsClientLike {
  const obs = new OBSWebSocket();
  return {
    async connect(url, password) {
      await obs.connect(url, password);
    },
    async startRecord() {
      await obs.call("StartRecord");
    },
    async stopRecord() {
      const r = await obs.call("StopRecord");
      return { outputPath: r.outputPath };
    },
    async disconnect() {
      await obs.disconnect();
    },
    onClosed(cb) {
      obs.on("ConnectionClosed", cb);
    },
  };
}
