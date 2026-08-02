import OBSWebSocket from "obs-websocket-js";

/** The OBS control surface narrowed to a minimal API; recorder unit tests all
 * use a fake. */
export interface ObsClientLike {
  connect(url: string, password?: string): Promise<void>;
  startRecord(): Promise<void>;
  stopRecord(): Promise<{ outputPath: string }>;
  /** C1 fix: after reconnecting, reconcile the messy state against OBS's actual
   * recording status instead of trusting the local in-memory flag alone. */
  getRecordStatus(): Promise<{ outputActive: boolean }>;
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
    async getRecordStatus() {
      const r = await obs.call("GetRecordStatus");
      return { outputActive: r.outputActive };
    },
    async disconnect() {
      await obs.disconnect();
    },
    onClosed(cb) {
      obs.on("ConnectionClosed", cb);
    },
  };
}
