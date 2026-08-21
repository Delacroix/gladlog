/**
 * Minimal storage contract shared by the streamer (write side) and the
 * collector (read side). Deliberately tiny — 4 methods, flat keys, no
 * streaming/multipart — so a Google Drive folder (via localDir) is drop-in.
 */
export interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  /** Returns keys under prefix in lexicographic order. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing key resolves silently. */
  delete(key: string): Promise<void>;
  /**
   * Optional: when `get(key)` yields unusable bytes, explain why if the
   * backend can tell (e.g. a cloud-only placeholder the sync client has not
   * hydrated). Returned text is appended to the collector's deferral warning
   * so the operator sees the cause instead of a bare "not fully synced yet".
   */
  diagnose?(key: string): Promise<string | undefined>;
}
