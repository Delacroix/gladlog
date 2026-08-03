import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Release-side config gate for auto-update.
 *
 * None of the settings checked here have a runtime test that could catch a
 * regression: if `build.publish` disappears, or the NSIS artifact name gets a
 * space back, or the workflow stops uploading latest.yml, every installed
 * client keeps working normally and simply never finds an update again — no
 * crash, no error, nothing in any log we can see. The failure mode is
 * invisible in production, so this file is the only place it can be caught.
 *
 * Reads the real files off disk (same cross-file gate style as
 * diagnosticLevel.test.ts) instead of importing them, so what is checked is
 * the file that actually ships.
 */

const desktopDir = join(__dirname, "..");
const repoRoot = join(__dirname, "../../..");
const workflowPath = join(repoRoot, ".github/workflows/build.yml");

interface DesktopPackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    publish?: { provider?: string; owner?: string; repo?: string };
    nsis?: { artifactName?: string };
  };
}

function readPkg(): DesktopPackageJson {
  return JSON.parse(
    readFileSync(join(desktopDir, "package.json"), "utf-8"),
  ) as DesktopPackageJson;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("发布端配置门规(自动更新的地基)", () => {
  it("build.publish 指向正式仓库 —— 没有它就没有 app-update.yml,客户端不知道去哪查", () => {
    expect(readPkg().build.publish).toEqual({
      provider: "github",
      owner: "mingjianliu",
      repo: "gladlog",
    });
  });

  it("NSIS artifactName 无空格且过 isSafeGithubName —— latest.yml 的 path 必须与 Release 资产名逐字节相同", () => {
    const artifactName = readPkg().build.nsis?.artifactName ?? "";
    // Keep the pattern verbatim: electron-builder expands ${...} itself.
    expect(artifactName).toBe("${productName}.Setup.${version}.${ext}");
    expect(artifactName).not.toMatch(/\s/);
    // Same predicate as electron-builder's isSafeGithubName
    // (app-builder-lib/out/platformPackager.js:687-689). If the expanded name
    // fails it, computeSafeArtifactNameIfNeeded rewrites the name written into
    // latest.yml while the uploaded asset keeps another one → download 404.
    const expanded = artifactName
      .replace("${productName}", "gladlog")
      .replace("${version}", "0.1.20")
      .replace("${ext}", "exe");
    expect(expanded).toBe("gladlog.Setup.0.1.20.exe");
    expect(expanded).toMatch(/^[0-9A-Za-z._-]+$/);
  });

  it("electron-updater 在 dependencies 而不是 devDependencies", () => {
    // What actually matters is which list it is in, not the exact patch level:
    // externalizeDepsPlugin externalizes `dependencies` only, and
    // electron-builder only ships `dependencies` into the packaged node_modules.
    // The major is still pinned — a 6→7 breaking change should go red.
    const pkg = readPkg();
    expect(pkg.dependencies["electron-updater"]).toMatch(/^\^6\./);
    expect(pkg.devDependencies["electron-updater"]).toBeUndefined();
  });

  it("死配置 electron-builder.yml 已删除", () => {
    // package.json's `build` field wins; a stray electron-builder.yml is never
    // read, so anything written into it silently does nothing.
    expect(existsSync(join(desktopDir, "electron-builder.yml"))).toBe(false);
  });

  it("build.yml 两处 glob 都收 latest.yml 与 .blockmap(upload-artifact + release 各一)", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.yml"),
    ).toBeGreaterThanOrEqual(2);
    expect(
      countOccurrences(wf, "packages/desktop/dist-app/*.blockmap"),
    ).toBeGreaterThanOrEqual(2);
  });

  it("build.yml 不许出现 .yaml 形态的 glob —— 会把含本机绝对路径的 builder-effective-config.yaml 传上 Release", () => {
    const wf = readFileSync(workflowPath, "utf-8");
    expect(wf).not.toContain(".y*ml");
    expect(wf).not.toContain(".yaml");
  });
});
