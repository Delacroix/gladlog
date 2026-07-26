import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readNthLine } from "./matchStore";

/** 判据:与旧实现 `content.split("\n")[n]` 逐字节等价(undefined→null)。
 * 覆盖跨 1MB 块边界的行、CJK 多字节、CRLF 行尾 \r 保留、尾行无 \n、
 * 越界与空行。 */
describe("readNthLine 与 split 参照等价", () => {
  const dir = mkdtempSync(join(tmpdir(), "gl-nthline-"));

  const check = async (file: string, indexes: number[]) => {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    for (const n of indexes) {
      const expected = lines[n] ?? null;
      expect(await readNthLine(file, n)).toBe(expected);
    }
  };

  it("大文件:行跨 1MB 块边界 + CJK 多字节", async () => {
    // 每行 ~1000 字节的 CJK 行 × 3000 ≈ 8.8MB(UTF-8 汉字 3 字节),
    // 必然多次跨 1MB 读块边界
    const line = "法术伤害测试行".repeat(48);
    const rows = Array.from({ length: 3000 }, (_, i) => `${i},${line}`);
    const file = join(dir, "big.txt");
    writeFileSync(file, rows.join("\n"));
    await check(file, [0, 1, 349, 350, 351, 1499, 2998, 2999, 3000, 5000]);
  });

  it("CRLF 行尾 \\r 原样保留;空行;尾行无 \\n;尾随 \\n 的末空元素", async () => {
    const file = join(dir, "mixed.txt");
    writeFileSync(file, "a\r\nb\n\nc最后");
    await check(file, [0, 1, 2, 3, 4]);
    const file2 = join(dir, "trailing.txt");
    writeFileSync(file2, "x\ny\n");
    await check(file2, [0, 1, 2, 3]);
  });
});
