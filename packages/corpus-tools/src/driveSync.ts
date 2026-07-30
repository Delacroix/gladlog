/** fetch-pvp-logs → Google Drive 归档(rclone)的纯逻辑部分。
 * spawn 壳在 scripts/syncPvpLogsToDrive.ts;这里只放可单测的 args 构建
 * 与输出解析。设计:docs/plans/2026-07-30-pvp-logs-drive-sync-plan.md。 */

export interface DriveSyncConfig {
  src: string;
  remote: string;
  dest: string;
  dryRun: boolean;
}

/** 裸 copy(size+modtime 增量)而非 --ignore-existing:log 不可变天然跳过,
 * manifest.json 每次 fetch 变大必须重传。 */
export function buildRcloneCopyArgs(cfg: DriveSyncConfig): string[] {
  return [
    "copy",
    cfg.src,
    `${cfg.remote}:${cfg.dest}`,
    "--progress",
    "--transfers",
    "4",
    "--checkers",
    "8",
    "--exclude",
    ".DS_Store",
    ...(cfg.dryRun ? ["--dry-run"] : []),
  ];
}

/** `rclone listremotes` 输出 → remote 名列表(行尾冒号剥掉)。 */
export function parseListRemotes(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(":"))
    .map((l) => l.slice(0, -1));
}
