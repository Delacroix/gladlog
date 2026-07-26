import { slimStoredDoc } from "./slimDoc";

/**
 * doc 字节直传的消费端解析(2026-07-26):main 的 matches:get 只回原始
 * 字节,解析在 preload(与 renderer 同进程同堆)——一份 doc 全链路只
 * 物化这一次。slim 兜底跑共享谓词:本机库已迁移全瘦,但外来旧肥档在
 * 后台自愈完成前的首次打开仍是肥字节,产品所见必须与旧路径(main 侧
 * slim 后下发)一致;幂等,瘦档零改动。
 *
 * 放 shared:preload 消费,测试直接拿它对旧管线做 deep-equal。
 */
export function parseDocBytes(buf: unknown): unknown | null {
  if (buf == null) return null;
  try {
    const text =
      typeof Buffer !== "undefined" && Buffer.isBuffer(buf)
        ? buf.toString("utf-8")
        : new TextDecoder().decode(buf as ArrayBuffer | Uint8Array);
    // 损坏/半写的 match.json:旧管线(worker 侧 try/catch)回 null,
    // 这里同语义 —— 抛出去会变成 renderer 的未处理 rejection(agy F2)。
    const doc: unknown = JSON.parse(text);
    try {
      slimStoredDoc(doc);
    } catch {
      /* 兜底失败不拦加载 */
    }
    return doc;
  } catch {
    return null;
  }
}
