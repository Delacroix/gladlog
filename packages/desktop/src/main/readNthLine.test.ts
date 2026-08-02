import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readNthLine } from "./matchStore";

/** Criterion: byte-for-byte equivalent to the old implementation
 * `content.split("\n")[n]` (with undefined → null).
 * Covers lines straddling the 1MB chunk boundary, multi-byte CJK, the \r of
 * CRLF line endings being preserved, a final line without \n, out-of-range
 * indexes and empty lines. */
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
    // 3000 CJK lines of ~1000 bytes each ≈ 8.8MB (a UTF-8 Han character is
    // 3 bytes), which necessarily straddles the 1MB read-chunk boundary many
    // times
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
