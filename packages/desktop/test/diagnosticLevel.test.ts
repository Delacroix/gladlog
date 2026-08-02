import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DIAGNOSTIC_LEVEL,
  diagnosticLevel,
} from "../src/shared/diagnosticLevel";

/**
 * Diagnostic entries carry no level field of their own (protocol.ts only has
 * code/detail/fileKey), so the developer page's warn/error badge filtering has
 * to level by code. The leveling table is a **whitelist**: any new code not in
 * the table is reported as error — better noisy than hiding a real error in
 * warn.
 */
describe("diagnosticLevel", () => {
  it("流程性失败 = error", () => {
    expect(diagnosticLevel("BUILD_FAILED")).toBe("error");
    expect(diagnosticLevel("LOGS_DIR_UNREADABLE")).toBe("error");
  });

  it("解析器不变量违反 = warn(数据有瑕疵但对局仍可用)", () => {
    expect(diagnosticLevel("monotonic")).toBe("warn");
    expect(diagnosticLevel("hp-range")).toBe("warn");
    expect(diagnosticLevel("death-has-damage")).toBe("warn");
  });

  it("表外的未知 code 保守按 error", () => {
    expect(diagnosticLevel("SOMETHING_NEW")).toBe("error");
    expect(diagnosticLevel("")).toBe("error");
  });

  /**
   * Drift guard: if upstream adds or renames a diagnostic code and this table
   * is not updated, badge filtering silently goes wrong —— the old "chained
   * whitelist rot" disease (memory: gladlog-whitelist-chain-rot). This test
   * reads the code literals straight out of the source and reconciles them
   * against the leveling table.
   */
  it("上游 parser 不变量的 code 全部在定级表里", () => {
    const src = readFileSync(
      join(__dirname, "../../parser/src/invariants.ts"),
      "utf-8",
    );
    const codes = [...src.matchAll(/code:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(0);
    const missing = codes.filter((c) => !(c in DIAGNOSTIC_LEVEL));
    expect(missing).toEqual([]);
  });
});
