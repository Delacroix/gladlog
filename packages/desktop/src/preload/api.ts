import type { FileStatus } from "../shared/protocol";
import type { GladlogSettings } from "../main/settingsStore";
import type { StoredMatchMeta } from "../main/matchStore";
import type { RulesDoc } from "@gladlog/analysis/src/learning/types";
import type { LearningState } from "../main/learning";

export interface LogsStatusSnapshot {
  watching: boolean;
  logsDir: string;
  files: FileStatus[];
}
export interface DiagnosticEntry {
  fileKey?: string;
  code: string;
  detail?: string;
  at: number;
}

export interface GladlogApi {
  logs: {
    getStatus(): Promise<LogsStatusSnapshot | null>;
    onStatusChanged(cb: (s: LogsStatusSnapshot) => void): () => void;
    onMatchStored(cb: (meta: StoredMatchMeta) => void): () => void;
    onDiagnostic(cb: (d: DiagnosticEntry) => void): () => void;
    /** 历史日志导入:弹文件选择框 → 逐文件解析入库;取消 → null。 */
    importFiles(): Promise<{
      files: number;
      stored: number;
      dup: number;
      failed: number;
    } | null>;
    onImportProgress(
      cb: (p: {
        file: string;
        i: number;
        n: number;
        stored: number;
        dup: number;
      }) => void,
    ): () => void;
  };
  matches: {
    list(): Promise<StoredMatchMeta[]>;
    get(id: string): Promise<unknown | null>;
    page(opts: { before?: number; limit: number }): Promise<StoredMatchMeta[]>;
    /** 一次性回填富行字段(逐目录读 match.json 重铸 meta),用户主动触发。 */
    rebuildIndex(): Promise<{ updated: number; failed: number }>;
    /** B2 溯源:事件 lineIndex → raw.txt 原始行(shuffle 传轮 sequenceNumber)。
     * 旧档无 lineIndex / 行不存在 → null,UI 降级隐藏。 */
    rawLine(
      id: string,
      opts: { roundSeq?: number | null; lineIndex: number },
    ): Promise<{ line: string; fileLine: number } | null>;
    /** C3 导出图片:离屏窗口渲染同一 renderer 后整页截图。savePath 仅
     * E2E/脚本直传;UI 调用省略 → 弹系统保存框。取消/失败 → null。 */
    exportImage(opts: {
      matchId: string;
      roundSeq?: number | null;
      range?: { fromS: number; toS: number } | null;
      savePath?: string;
    }): Promise<{ path: string; width: number; height: number } | null>;
  };
  settings: {
    get(): Promise<GladlogSettings>;
    save(partial: Partial<GladlogSettings>): Promise<GladlogSettings>;
  };
  app: {
    getVersion(): Promise<string>;
    selectDirectory(): Promise<string | null>; // 返回选中目录;取消 → null。选中即自动 save wowDirectory 并重启监控
    openExternal(url: string): Promise<void>;
  };
  compare: {
    run(input: {
      matchId: string;
      healerMetrics: Record<string, number | null>;
      spec: string;
      talents: number[];
      bracket: string;
      archetype: string;
      wowBuild: string;
    }): Promise<void>;
    cancel(): Promise<void>;
    getCached(matchId: string): Promise<unknown | null>;
    onDelta(cb: (d: { matchId: string; text: string }) => void): () => void;
    onDone(cb: (d: { matchId: string; result: unknown }) => void): () => void;
    onError(cb: (d: { matchId: string; message: string }) => void): () => void;
  };
  analysis: {
    run(input: {
      matchId: string;
      candidates: any[];
      richContext: string;
      spec: string;
    }): Promise<void>;
    /** 无参 = 全场取消;带 matchId = 只作废该场在飞的 run/deepen(批量用)。 */
    cancel(matchId?: string): Promise<void>;
    /** 重挂时的单次原子查询:缓存 + 是否在跑。分两次问会漏掉恰好此刻完成的那轮。 */
    getState(
      matchId: string,
    ): Promise<{ cached: unknown | null; running: boolean }>;
    getCached(matchId: string): Promise<unknown | null>;
    getFlags(matchId: string): Promise<Record<string, string>>;
    /** 批量分析用:已有有效缓存(当前语言 + 当前 promptVersion)的对局 id。 */
    listAnalyzed(): Promise<string[]>;
    /** 跨场 finding 聚合(category 计数 + 最近实例 + 标记统计)。 */
    aggregate(): Promise<
      Array<{
        category: string;
        count: number;
        recurring: number;
        done: number;
        recent: Array<{
          matchId: string;
          title: string;
          severity: string;
          createdAt: number;
        }>;
      }>
    >;
    /** 错题本:全部已分析对局的 findings 按类型分组(含 meta 与标记)。 */
    notebook(): Promise<
      Array<{
        category: string;
        count: number;
        recurring: number;
        done: number;
        entries: Array<{
          matchId: string;
          flagKey: string;
          flag: string | null;
          title: string;
          explanation: string;
          severity: string;
          startTime: number;
          zoneId?: string;
          result?: string;
          bracket?: string;
        }>;
      }>
    >;
    /** 深挖轮(自动追问):初轮 done 后由 renderer 触发,证据包在 renderer 确定性构建。 */
    deepen(input: {
      matchId: string;
      findings: unknown[];
      packs: unknown[];
      spec: string;
      ownerName?: string;
    }): Promise<void>;
    /** 选段分析(#16):pack 由 renderer 确定性构建;单请求-响应,不走 emit。 */
    analyzeWindow(input: {
      matchId: string;
      fromS: number;
      toS: number;
      pack: unknown;
      kind: "survival" | "offensive";
      spec: string;
      ownerName?: string;
    }): Promise<
      | {
          status: "ok";
          text: string;
          chips: Array<{
            t: number;
            label: string;
            unitNames: string[];
            spellId?: string;
          }>;
          fromCache: boolean;
        }
      | { status: "audit-empty" }
      | { status: "no-client" }
      | { status: "busy" }
      | { status: "error" }
    >;
    setFlag(
      matchId: string,
      key: string,
      flag: "done" | "recurring" | null,
    ): Promise<Record<string, string>>;
    onDelta(cb: (d: { matchId: string; text: string }) => void): () => void;
    onDone(cb: (d: { matchId: string; result: unknown }) => void): () => void;
    onError(cb: (d: { matchId: string; message: string }) => void): () => void;
  };
  /** 跨对局学习(spec 2026-07-26):规则读取、状态、手动整合。 */
  learning: {
    getRules(): Promise<RulesDoc | null>;
    getState(): Promise<LearningState>;
    consolidate(): Promise<void>;
    onProgress(cb: (p: { scanned: number; total: number }) => void): () => void;
    onDone(
      cb: (d: {
        rules: number;
        distilled: number;
        dropped: number;
        distillError?: string;
      }) => void,
    ): () => void;
    onError(cb: (d: { message: string }) => void): () => void;
  };
  icon: {
    get(name: string): Promise<string | null>;
  };
  /** 本地 CLI 后端(claudeCli/agy/codex)自动检测:命令路径留空时设置页
   *  用它显示「已检测到:…」/「未检测到」。非本地后端 → path: null。 */
  ai: {
    detectCli(backend: string): Promise<{ path: string | null }>;
  };
  /** 开发者页:最近 10 次 AI 调用的 prompt 与原始返回(仅内存)。 */
  debug: {
    aiCalls(): Promise<
      Array<{
        kind: "analysis" | "compare";
        matchId: string;
        at: number;
        model: string;
        prompt: string;
        raw: string;
      }>
    >;
  };
}
declare global {
  interface Window {
    gladlog: GladlogApi;
  }
}
