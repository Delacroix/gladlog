import { slimMatchParams } from "@gladlog/parser";

/**
 * 存档 doc 形态的瘦身入口:match 直瘦,shuffle 逐轮瘦。返回是否有实际改动。
 *
 * 放 src/shared(谓词单源):main 的自愈路径、scripts/slimLibrary 的全库
 * 迁移、以及 doc 字节直传后 preload 侧的解析兜底,消费的必须是同一个函数。
 * 底层位裁剪语义见 @gladlog/parser 的 slim.ts(幂等,已瘦档重跑零改动)。
 */
export function slimStoredDoc(doc: unknown): boolean {
  const data = (doc as { data?: { rounds?: unknown[]; units?: unknown } })
    ?.data;
  if (!data) return false;
  let changed = false;
  if (Array.isArray(data.rounds)) {
    for (const r of data.rounds)
      if ((r as { units?: unknown }).units)
        changed =
          slimMatchParams(r as Parameters<typeof slimMatchParams>[0]) ||
          changed;
  } else if (data.units) {
    changed = slimMatchParams(data as Parameters<typeof slimMatchParams>[0]);
  }
  return changed;
}
