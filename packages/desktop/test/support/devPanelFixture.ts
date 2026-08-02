import type { StoredMatchMeta } from "../../src/main/matchStore";
import type {
  DiagnosticEntry,
  LogsStatusSnapshot,
} from "../../src/preload/api";

export interface AiCallEntry {
  kind: "analysis" | "compare";
  matchId: string;
  at: number;
  model: string;
  prompt: string;
  raw: string;
}

export interface DevFixtureOptions {
  metas?: StoredMatchMeta[];
  detail?: unknown;
  aiCalls?: AiCallEntry[];
  status?: LogsStatusSnapshot | null;
  /** rebuildIndex() 的返回;不传则立即成功。 */
  rebuild?: () => Promise<{ updated: number; failed: number }>;
}

export interface DevFixtureHandles {
  /** 传给 render(…, { container }) 的挂载点 */
  container: HTMLElement;
  emitDiagnostic(d: DiagnosticEntry): void;
  emitRebuildProgress(p: { i: number; n: number; id: string }): void;
  emitStatus(s: LogsStatusSnapshot): void;
  /** 记录被调用的 IPC(断言「点了按钮真的发了请求」用) */
  calls: { reparse: string[]; openDir: string[]; saveText: unknown[] };
}

const DEFAULT_META: StoredMatchMeta = {
  id: "m1",
  kind: "match",
  bracket: "3v3",
  zoneId: "1505",
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_180_000,
  result: "Win",
  storedAt: 1_700_000_200_000,
} as StoredMatchMeta;

/**
 * 开发者页组件测试的 bridge 桩。桩里每个面都必须存在 —— DevPanel 里访问
 * bridge 的地方虽有 try/catch,但缺面会让被测行为静默降级成「什么都没发生」,
 * 测试就变成了自我实现的预言。
 */
export function installDevFixture(
  opts: DevFixtureOptions = {},
): DevFixtureHandles {
  const metas = opts.metas ?? [DEFAULT_META];
  const diagCbs: Array<(d: DiagnosticEntry) => void> = [];
  const progressCbs: Array<(p: { i: number; n: number; id: string }) => void> =
    [];
  const statusCbs: Array<(s: LogsStatusSnapshot) => void> = [];
  const calls: DevFixtureHandles["calls"] = {
    reparse: [],
    openDir: [],
    saveText: [],
  };

  const sub = <T>(list: Array<(p: T) => void>) => {
    return (cb: (p: T) => void) => {
      list.push(cb);
      return () => {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    };
  };

  (window as unknown as { __gladlogFixture: unknown }).__gladlogFixture = {
    logs: {
      getStatus: async () =>
        opts.status === undefined
          ? { watching: true, logsDir: "/wow/Logs", files: [] }
          : opts.status,
      onStatusChanged: sub(statusCbs),
      onMatchStored: () => () => {},
      onDiagnostic: sub(diagCbs),
    },
    settings: {
      get: async () => ({ wowDirectory: "/wow", aiBackend: "anthropic" }),
      save: async () => ({}),
    },
    matches: {
      list: async () => metas,
      get: async () => opts.detail ?? null,
      rebuildIndex: opts.rebuild ?? (async () => ({ updated: 1, failed: 0 })),
      onRebuildProgress: sub(progressCbs),
      reparse: async (id: string) => {
        calls.reparse.push(id);
        return { ok: true };
      },
      openDir: async (id: string) => {
        calls.openDir.push(id);
        return true;
      },
    },
    app: {
      selectDirectory: async () => null,
      saveTextFile: async (o: unknown) => {
        calls.saveText.push(o);
        return "/tmp/out.json";
      },
    },
    debug: { aiCalls: async () => opts.aiCalls ?? [] },
  };

  const container = document.createElement("div");
  document.body.appendChild(container);

  return {
    container,
    calls,
    emitDiagnostic: (d) => diagCbs.forEach((cb) => cb(d)),
    emitRebuildProgress: (p) => progressCbs.forEach((cb) => cb(p)),
    emitStatus: (s) => statusCbs.forEach((cb) => cb(s)),
  };
}
