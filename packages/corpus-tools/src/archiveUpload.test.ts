import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REMOTE_ROOT,
  buildArchiveUploadArgs,
  uploadSucceeded,
} from "./archiveUpload";

const cfg = {
  stagingDir: "/s/2026-08-01",
  remote: "gdrive",
  driveDest: "2026/08/01",
  dryRun: false,
};

describe("buildArchiveUploadArgs", () => {
  it("copy 到 remote:根/YYYY/MM/DD", () => {
    const a = buildArchiveUploadArgs(cfg);
    expect(a[0]).toBe("copy");
    expect(a[1]).toBe("/s/2026-08-01");
    expect(a[2]).toBe(`gdrive:${ARCHIVE_REMOTE_ROOT}/2026/08/01`);
  });
  it("用 copy 而非 sync —— sync 会按本地删云端,而本地是传完即删的暂存", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("sync");
  });
  it("不加 --ignore-existing —— index.jsonl 每批都会变大,必须允许覆盖", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--ignore-existing");
  });
  it("dryRun 时带 --dry-run", () => {
    expect(buildArchiveUploadArgs({ ...cfg, dryRun: true })).toContain(
      "--dry-run",
    );
  });
  it("非 dryRun 时不带 --dry-run", () => {
    expect(buildArchiveUploadArgs(cfg)).not.toContain("--dry-run");
  });
});

describe("uploadSucceeded", () => {
  it("退出码 0 且无致命错误 → 成功", () => {
    expect(uploadSucceeded(0, "Transferred: 12 / 12")).toBe(true);
  });
  it("非 0 退出码 → 失败", () => {
    expect(uploadSucceeded(1, "")).toBe(false);
  });
  it("退出码 0 但 stderr 报 ERROR → 失败(rclone 有时部分失败仍退 0)", () => {
    expect(uploadSucceeded(0, "ERROR : m1.txt.gz: Failed to copy")).toBe(false);
  });
});
