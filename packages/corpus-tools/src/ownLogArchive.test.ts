import { describe, expect, it } from "vitest";

import { buildRcloneCopyArgs } from "./driveSync";
import {
  gzNameFor,
  isOwnLogName,
  OWN_LOG_QUIET_MS,
  parseOwnLogManifest,
  selectOwnLogsToArchive,
  serializeOwnLogManifest,
} from "./ownLogArchive";

const NOW = 1_800_000_000_000;
/** Older than the quiet period: a finished session, safe to archive. */
const SETTLED = NOW - OWN_LOG_QUIET_MS - 1;

function file(name: string, size: number, mtimeMs = SETTLED) {
  return { name, size, mtimeMs };
}

describe("isOwnLogName", () => {
  it("accepts a collector-reconstructed log", () => {
    expect(isOwnLogName("WoWCombatLog-082426_005617.win-pc.8e0c6b9e.txt")).toBe(
      true,
    );
  });

  it("rejects the archive's own byproducts and dotfiles", () => {
    expect(isOwnLogName("manifest.json")).toBe(false);
    expect(isOwnLogName(".DS_Store")).toBe(false);
    expect(
      isOwnLogName("WoWCombatLog-082426_005617.win-pc.8e0c6b9e.txt.gz"),
    ).toBe(false);
  });
});

describe("selectOwnLogsToArchive", () => {
  it("picks a settled log that the manifest has never seen", () => {
    const picked = selectOwnLogsToArchive({
      files: [file("WoWCombatLog-a.win-pc.1111.txt", 100)],
      manifest: {},
      nowMs: NOW,
    });
    expect(picked.map((f) => f.name)).toEqual([
      "WoWCombatLog-a.win-pc.1111.txt",
    ]);
  });

  it("skips a log already archived at the same size", () => {
    const picked = selectOwnLogsToArchive({
      files: [file("WoWCombatLog-a.win-pc.1111.txt", 100)],
      manifest: { "WoWCombatLog-a.win-pc.1111.txt": 100 },
      nowMs: NOW,
    });
    expect(picked).toEqual([]);
  });

  // The whole reason the manifest stores a size: a session archived while the
  // streamer was still appending is a truncated snapshot on Drive, and dedup by
  // filename alone would pin that truncation forever.
  it("re-archives a log that grew after it was archived", () => {
    const picked = selectOwnLogsToArchive({
      files: [file("WoWCombatLog-a.win-pc.1111.txt", 250)],
      manifest: { "WoWCombatLog-a.win-pc.1111.txt": 100 },
      nowMs: NOW,
    });
    expect(picked.map((f) => f.name)).toEqual([
      "WoWCombatLog-a.win-pc.1111.txt",
    ]);
  });

  it("skips a log still being written (inside the quiet period)", () => {
    const picked = selectOwnLogsToArchive({
      files: [file("WoWCombatLog-a.win-pc.1111.txt", 100, NOW - 1000)],
      manifest: {},
      nowMs: NOW,
    });
    expect(picked).toEqual([]);
  });

  it("skips a growing log even when it is already in the manifest", () => {
    const picked = selectOwnLogsToArchive({
      files: [file("WoWCombatLog-a.win-pc.1111.txt", 250, NOW - 1000)],
      manifest: { "WoWCombatLog-a.win-pc.1111.txt": 100 },
      nowMs: NOW,
    });
    expect(picked).toEqual([]);
  });

  it("ignores non-log entries in the directory", () => {
    const picked = selectOwnLogsToArchive({
      files: [file(".DS_Store", 6148), file("manifest.json", 12)],
      manifest: {},
      nowMs: NOW,
    });
    expect(picked).toEqual([]);
  });
});

describe("manifest round-trip", () => {
  it("restores the sizes it serialized", () => {
    const m = { "WoWCombatLog-a.win-pc.1111.txt": 42 };
    expect(parseOwnLogManifest(serializeOwnLogManifest(m))).toEqual(m);
  });

  it("treats a missing or corrupt manifest as empty rather than throwing", () => {
    expect(parseOwnLogManifest("")).toEqual({});
    expect(parseOwnLogManifest("{not json")).toEqual({});
    expect(parseOwnLogManifest('["wrong shape"]')).toEqual({});
  });

  it("drops entries whose size is not a usable number", () => {
    expect(parseOwnLogManifest('{"a.txt":"100","b.txt":7}')).toEqual({
      "b.txt": 7,
    });
  });
});

describe("gzNameFor", () => {
  it("appends .gz to the source name", () => {
    expect(gzNameFor("WoWCombatLog-a.win-pc.1111.txt")).toBe(
      "WoWCombatLog-a.win-pc.1111.txt.gz",
    );
  });
});

// The "no TTL" requirement is one rclone subcommand away from being violated:
// `rclone sync` deletes remote files that are absent locally, so the day the
// local 21GB is cleared, the Drive copy would be cleared with it. Pin it.
describe("upload args never delete anything on Drive", () => {
  const args = buildRcloneCopyArgs({
    src: "/staging",
    remote: "gdrive",
    dest: "gladlog-own-logs",
    dryRun: false,
  });

  it("uses copy, not sync", () => {
    expect(args[0]).toBe("copy");
    expect(args).not.toContain("sync");
  });

  it("carries no delete flag", () => {
    expect(args.filter((a) => a.startsWith("--delete"))).toEqual([]);
  });
});
