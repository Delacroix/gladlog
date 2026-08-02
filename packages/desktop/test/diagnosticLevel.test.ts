import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DIAGNOSTIC_LEVEL,
  diagnosticLevel,
} from "../src/shared/diagnosticLevel";

/**
 * 诊断条目本身没有 level 字段(protocol.ts 只有 code/detail/fileKey),
 * 开发者页的 warn/error 徽标筛选要靠 code 定级。定级表是**白名单**:
 * 出现表外的新 code 一律按 error 上报,宁可吵也不要把真错误藏进 warn 里。
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
   * 防漂移:上游新增/改名 diagnostic code 而这里没跟,徽标筛选会静默失准
   * ——「串联白名单腐烂」的老病(memory: gladlog-whitelist-chain-rot)。
   * 这条测试直接读源码里的 code 字面量,和定级表对账。
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
