/** Drive 上的归档根目录。 */
export const ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive";

export interface ArchiveUploadConfig {
  /** 本地某一天的暂存目录,如 /staging/2026-08-01 */
  stagingDir: string;
  /** rclone remote 名,如 gdrive */
  remote: string;
  /** Drive 上的相对目标,如 2026/08/01 */
  driveDest: string;
  dryRun: boolean;
}

/**
 * 用 `copy` 而不是 `sync`:暂存目录是传完即删的中转,`sync` 会按本地状态去删
 * 云端已归档的文件 —— 那是灾难性的。
 *
 * 也不加 `--ignore-existing`:index.jsonl 每批都会变大,必须允许覆盖
 * (与 driveSync.ts 同一条教训)。
 */
export function buildArchiveUploadArgs(cfg: ArchiveUploadConfig): string[] {
  return [
    "copy",
    cfg.stagingDir,
    `${cfg.remote}:${ARCHIVE_REMOTE_ROOT}/${cfg.driveDest}`,
    "--transfers",
    "4",
    "--checkers",
    "8",
    "--exclude",
    ".DS_Store",
    ...(cfg.dryRun ? ["--dry-run"] : []),
  ];
}

/**
 * 上传是否成功。除退出码外还要看 stderr:rclone 在部分文件失败时仍可能退 0,
 * 而我们**只在确认成功后才记账**,判宽了就是永久丢文件。
 */
export function uploadSucceeded(exitCode: number, stderr: string): boolean {
  if (exitCode !== 0) return false;
  return !/\bERROR\b/.test(stderr);
}

/** 云端某一天的 index.jsonl 路径参数(用于 `rclone cat`)。 */
export function buildIndexCatArgs(cfg: {
  remote: string;
  driveDest: string;
}): string[] {
  return [
    "cat",
    `${cfg.remote}:${ARCHIVE_REMOTE_ROOT}/${cfg.driveDest}/index.jsonl`,
  ];
}

/**
 * `rclone cat index.jsonl` 的三态结果。
 *
 * 必须把「这一天还没有索引」(首次上传,正常)与「读失败」(网络/鉴权)分开:
 * 前者按空索引继续,后者**必须放弃本次冲刷**并保留暂存 —— 把读失败当空处理,
 * 就会用本地这一批覆盖掉云端完整的索引,那是不可逆的删除。
 */
export function classifyIndexFetch(
  exitCode: number,
  stderr: string,
): "ok" | "missing" | "error" {
  if (exitCode === 0) return "ok";
  if (/not found|no such|does ?n[o']t exist|didn't find/i.test(stderr)) {
    return "missing";
  }
  return "error";
}
