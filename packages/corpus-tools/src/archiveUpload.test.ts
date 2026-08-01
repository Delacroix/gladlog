import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REMOTE_ROOT,
  buildArchiveUploadArgs,
  buildIndexCatArgs,
  classifyIndexFetch,
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

describe("buildIndexCatArgs", () => {
  it("cat 当天的 index.jsonl", () => {
    expect(
      buildIndexCatArgs({ remote: "gdrive", driveDest: "2026/08/01" }),
    ).toEqual(["cat", `gdrive:${ARCHIVE_REMOTE_ROOT}/2026/08/01/index.jsonl`]);
  });
});

describe("classifyIndexFetch", () => {
  it("退 0 → ok", () => {
    expect(classifyIndexFetch(0, "")).toBe("ok");
  });
  it("对象不存在(该日首次上传)→ missing,按空索引继续", () => {
    expect(classifyIndexFetch(1, "ERROR : index.jsonl: object not found")).toBe(
      "missing",
    );
    expect(classifyIndexFetch(1, "directory not found")).toBe("missing");
    expect(classifyIndexFetch(3, "Failed to cat: didn't find section")).toBe(
      "missing",
    );
  });
  it("网络/鉴权失败 → error,绝不能当空索引 —— 那会用一批覆盖掉云端整天的索引", () => {
    expect(
      classifyIndexFetch(1, "ERROR : couldn't connect: oauth2: token expired"),
    ).toBe("error");
    expect(classifyIndexFetch(1, "")).toBe("error");
  });
});
