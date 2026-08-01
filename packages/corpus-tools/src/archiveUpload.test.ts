import { describe, expect, it } from "vitest";

import {
  ARCHIVE_REMOTE_ROOT,
  buildArchiveUploadArgs,
  buildIndexCatArgs,
  classifyIndexFetch,
  rclonePreflightError,
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
  it("对象/目录不存在(该日首次上传)→ missing,按空索引继续", () => {
    expect(classifyIndexFetch(1, "ERROR : index.jsonl: object not found")).toBe(
      "missing",
    );
    expect(classifyIndexFetch(1, "directory not found")).toBe("missing");
    expect(classifyIndexFetch(1, "ERROR : error listing: file not found")).toBe(
      "missing",
    );
  });
  it("网络/鉴权失败 → error,绝不能当空索引 —— 那会用一批覆盖掉云端整天的索引", () => {
    expect(
      classifyIndexFetch(1, "ERROR : couldn't connect: oauth2: token expired"),
    ).toBe("error");
    expect(classifyIndexFetch(1, "")).toBe("error");
  });
  it("DNS 故障文案含 'no such host' —— 宽松的 /no such/ 会把它误判成 missing", () => {
    expect(
      classifyIndexFetch(
        1,
        'Failed to cat: Get "https://www.googleapis.com/drive/v3/files": dial tcp: lookup www.googleapis.com: no such host',
      ),
    ).toBe("error");
  });
  it("token 获取失败(同样含 'no such host')→ error", () => {
    expect(
      classifyIndexFetch(
        1,
        'couldn\'t fetch token: Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com: no such host',
      ),
    ).toBe("error");
  });
  it("rclone 配置错误(remote 名不存在)→ error,不是 missing", () => {
    expect(classifyIndexFetch(1, "didn't find section in config file")).toBe(
      "error",
    );
    expect(
      classifyIndexFetch(1, 'NOTICE: Config file "rclone.conf" not found'),
    ).toBe("error");
  });
});

describe("rclonePreflightError", () => {
  const remotes = ["gdrive", "backup"];
  it("rclone 装了且 remote 配了 → null(放行)", () => {
    expect(
      rclonePreflightError({ rcloneMissing: false, remotes, remote: "gdrive" }),
    ).toBeNull();
  });
  it("rclone 没装 → 报错并给安装命令,别开始扫 feed", () => {
    const msg = rclonePreflightError({
      rcloneMissing: true,
      remotes: [],
      remote: "gdrive",
    });
    expect(msg).toContain("未找到 rclone");
    expect(msg).toContain("brew install rclone");
  });
  it("RCLONE_REMOTE 打错 → 报错并列出现有 remote(否则白下 16.5GB 一个字节也传不上去)", () => {
    const msg = rclonePreflightError({
      rcloneMissing: false,
      remotes,
      remote: "gdirve",
    });
    expect(msg).toContain('"gdirve"');
    expect(msg).toContain("gdrive, backup");
  });
  it("一个 remote 都没配时也报错(现有:无)", () => {
    const msg = rclonePreflightError({
      rcloneMissing: false,
      remotes: [],
      remote: "gdrive",
    });
    expect(msg).toContain("无");
  });
  it("没装 rclone 时优先报「没装」而不是「remote 不存在」", () => {
    expect(
      rclonePreflightError({
        rcloneMissing: true,
        remotes: [],
        remote: "gdrive",
      }),
    ).toContain("未找到 rclone");
  });
});
