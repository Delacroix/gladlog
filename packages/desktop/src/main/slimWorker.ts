import { parentPort, workerData } from "worker_threads";
import { readFileSync, writeFileSync, renameSync } from "fs";

import { slimStoredDoc } from "../shared/slimDoc";

/**
 * 一次性自愈 worker(doc 字节直传后 main 不再 parse doc):对未瘦标记的
 * 旧肥档做 读 → parse → slim → 原子回写,并回报 shuffle 行偏移表;
 * main 只收这个小结果对象,重活全部离开主线程。
 * 谓词单源:与出厂(compose)/全库迁移(scripts/slimLibrary)共用
 * shared/slimDoc。幂等 —— 已瘦档 changed=false,只补 meta。
 */
try {
  const { filePath } = workerData as { filePath: string };
  const doc = JSON.parse(readFileSync(filePath, "utf8")) as {
    data?: { rounds?: Array<{ sequenceNumber: number; linesTotal: number }> };
  };
  const changed = slimStoredDoc(doc);
  if (changed) {
    const tmp = filePath + ".slim-tmp";
    writeFileSync(tmp, JSON.stringify(doc));
    renameSync(tmp, filePath);
  }
  const rounds = doc.data?.rounds;
  const roundLinesTotal = Array.isArray(rounds)
    ? [...rounds]
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
        .map((r) => ({ seq: r.sequenceNumber, lines: r.linesTotal }))
    : undefined;
  parentPort!.postMessage({ ok: true, changed, roundLinesTotal });
} catch {
  parentPort?.postMessage({ ok: false });
}
