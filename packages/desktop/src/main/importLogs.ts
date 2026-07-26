import { createReadStream } from "fs";
import { basename } from "path";
import {
  GladLogParser,
  type GladMatch,
  type GladShuffle,
} from "@gladlog/parser";

import type { MatchStore, StoredMatchMeta } from "./matchStore";

export interface ImportProgress {
  file: string;
  i: number; // 1-based 当前文件序号
  n: number;
  stored: number; // 累计新入库
  dup: number; // 累计去重跳过
}

export interface ImportSummary {
  files: number;
  stored: number;
  dup: number;
  failed: number;
}

/**
 * 历史日志一次性导入(phase3 #2c):逐文件流式跑 GladLogParser,
 * store.store 按 id 去重 → 重复导入天然幂等。与 watcher 的 tail/checkpoint
 * 增量模型无关,不动 checkpoint。
 *
 * 流式而非整读(2026-07-26 审计):旧版 readFile 单字符串 —— 本机最大日志
 * 406MB 已逼近 V8 单字符串 512MB 上限(再大直接抛),且 split 后 ~1GB 行
 * 数组 + 全部 parsed match 驻留到文件解析完。现在按流分块、手写 \n 切分
 * (readline 会吞 CRLF 的 \r,而 rawLines 字节精确是 log-pipeline 的契约,
 * 不能用),匹配一场入库一场;块间 for-await 天然让位事件循环。
 */
export async function importLogFiles(
  paths: string[],
  store: Pick<MatchStore, "store">,
  emit: (channel: string, payload: unknown) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    files: paths.length,
    stored: 0,
    dup: 0,
    failed: 0,
  };
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    try {
      const parser = new GladLogParser();
      const onItem = (item: GladMatch | GladShuffle) => {
        const r = store.store(item);
        if (r.stored) {
          summary.stored++;
          // 复用实时监控的入库通知,让左侧列表即时出现
          emit("gladlog:logs:matchStored", r.meta as StoredMatchMeta);
        } else if (r.meta) {
          summary.dup++;
        }
      };
      parser.on("match", onItem);
      parser.on("shuffle", onItem);
      // 与旧版 content.split("\n") 逐行等价:只按 \n 切,行尾 \r 原样保留,
      // 尾段(含空串)也照 push —— split 的末尾空元素语义一并复刻。
      const stream = createReadStream(path, {
        encoding: "utf-8",
        highWaterMark: 4 << 20,
      });
      let carry = "";
      for await (const chunk of stream) {
        const parts = (carry + (chunk as string)).split("\n");
        carry = parts.pop()!;
        for (const line of parts) parser.push(line);
      }
      parser.push(carry);
      parser.end();
    } catch {
      summary.failed++;
    }
    emit("gladlog:import:progress", {
      file: basename(path),
      i: i + 1,
      n: paths.length,
      stored: summary.stored,
      dup: summary.dup,
    } satisfies ImportProgress);
  }
  return summary;
}
