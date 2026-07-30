import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadBundledCorpus, gameBuildFromManifest } from "./corpusLoader";

function validCorpusJson(patch: string): string {
  return JSON.stringify({
    wowPatchVersion: patch,
    builtAt: "now",
    sourceFloor: 2300,
    buildGroups: {},
    cells: [],
  });
}

describe("corpusLoader", () => {
  it("reads + memoizes the corpus from the first path, returns null when all missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const p = join(dir, "reference_vectors.json");
    writeFileSync(p, validCorpusJson("12.1.0"));
    let calls = 0;
    const load = loadBundledCorpus(() => {
      calls++;
      return [p];
    });
    expect(load()!.wowPatchVersion).toBe("12.1.0");
    expect(load()!.cells).toEqual([]);
    expect(calls).toBe(1); // memoized: resolver called once
    const missing = loadBundledCorpus(() => [join(dir, "nope.json")]);
    expect(missing()).toBeNull();
  });

  it("falls back to the next path when the first (override) file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json"); // never written
    const load = loadBundledCorpus(() => [override, bundled]);
    expect(load()!.wowPatchVersion).toBe("12.1.0");
  });

  it("falls back to bundled when the override file is corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json");
    writeFileSync(override, "{ not valid json");
    const load = loadBundledCorpus(() => [override, bundled]);
    expect(load()!.wowPatchVersion).toBe("12.1.0");
  });

  it("falls back to bundled when the override file is missing the cells array", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json");
    writeFileSync(
      override,
      JSON.stringify({ wowPatchVersion: "13.0.0", builtAt: "now" }), // no cells
    );
    const load = loadBundledCorpus(() => [override, bundled]);
    expect(load()!.wowPatchVersion).toBe("12.1.0");
  });

  it("uses the override when it is valid, in preference to bundled", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json");
    writeFileSync(override, validCorpusJson("13.0.0"));
    const load = loadBundledCorpus(() => [override, bundled]);
    expect(load()!.wowPatchVersion).toBe("13.0.0");
  });

  it("returns null when every candidate path is missing or invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const override = join(dir, "override.json");
    writeFileSync(override, "not json at all");
    const bundled = join(dir, "nope.json"); // missing
    const load = loadBundledCorpus(() => [override, bundled]);
    expect(load()).toBeNull();
  });

  it("still memoizes across multiple candidate paths (resolvePaths called once)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json"); // missing
    let calls = 0;
    const load = loadBundledCorpus(() => {
      calls++;
      return [override, bundled];
    });
    load();
    load();
    load();
    expect(calls).toBe(1);
  });

  it("invokes onLoaded with the winning path and corpus metadata (for main-process logging)", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const bundled = join(dir, "bundled.json");
    writeFileSync(bundled, validCorpusJson("12.1.0"));
    const override = join(dir, "override.json"); // missing
    const events: Array<{ path: string; wowPatchVersion: string }> = [];
    const load = loadBundledCorpus(
      () => [override, bundled],
      (info) => events.push(info),
    );
    load();
    expect(events).toEqual([
      { path: bundled, wowPatchVersion: "12.1.0", builtAt: "now" },
    ]);
  });

  it("does not invoke onLoaded when every candidate fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "corpus-"));
    const missing = join(dir, "nope.json");
    const events: unknown[] = [];
    const load = loadBundledCorpus(
      () => [missing],
      (info) => events.push(info),
    );
    expect(load()).toBeNull();
    expect(events).toEqual([]);
  });

  it("reads the build from a game-data manifest", () => {
    expect(gameBuildFromManifest({ build: "12.1.0.68629" })).toBe(
      "12.1.0.68629",
    );
    expect(gameBuildFromManifest({})).toBe("0.0.0.0");
  });
});
