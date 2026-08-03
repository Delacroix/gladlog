import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { UNINSTALLER_PATTERN } from "./updater";

/** Shared-predicate gate (CLAUDE.md). evaluateGate's portable-vs-installed
 * decision is a claim about a file name that app-builder-lib's NSIS template
 * produces; no other code re-derives it, so this test reconciles our regex
 * against the template literal itself. If electron-builder ever renames the
 * uninstaller, CI goes red here instead of the feature silently degrading into
 * "every install looks portable and never updates".
 *
 * Pinned to app-builder-lib 26.15.3. */
const COMMON_NSH = join(
  __dirname,
  "../../../../node_modules/app-builder-lib/templates/nsis/common.nsh",
);

describe("卸载器文件名谓词与 app-builder-lib 模板一致", () => {
  it("UNINSTALL_FILENAME 模板渲染出来的名字必须被 UNINSTALLER_PATTERN 命中", () => {
    const src = readFileSync(COMMON_NSH, "utf-8");
    const m = /!define\s+UNINSTALL_FILENAME\s+"([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    const template = m?.[1] ?? "";
    expect(template).toContain("${PRODUCT_FILENAME}");
    for (const productFilename of ["gladlog", "gladlog next", "GladLog-2"]) {
      const rendered = template.replace("${PRODUCT_FILENAME}", productFilename);
      expect(UNINSTALLER_PATTERN.test(rendered)).toBe(true);
    }
  });
});
