/** Archive root directory on Drive. */
export const ARCHIVE_REMOTE_ROOT = "gladlog-pvp-archive";

export interface ArchiveUploadConfig {
  /** Local staging directory for one day, e.g. /staging/2026-08-01 */
  stagingDir: string;
  /** rclone remote name, e.g. gdrive */
  remote: string;
  /** Relative destination on Drive, e.g. 2026/08/01 */
  driveDest: string;
  dryRun: boolean;
}

/**
 * Use `copy`, not `sync`: the staging directory is a transit area emptied after
 * upload, and `sync` would delete already-archived files in the cloud to match
 * the local state — which would be catastrophic.
 *
 * Also do NOT add `--ignore-existing`: index.jsonl grows with every batch, so
 * overwriting must be allowed (same lesson as driveSync.ts).
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
 * Whether the upload succeeded. Besides the exit code, stderr must be checked:
 * rclone can still exit 0 when some files failed, and we **only write the ledger
 * after confirmed success** — judging this too loosely means permanently losing
 * files.
 */
export function uploadSucceeded(exitCode: number, stderr: string): boolean {
  if (exitCode !== 0) return false;
  return !/\bERROR\b/.test(stderr);
}

/** Path arguments for one day's index.jsonl in the cloud (for `rclone cat`). */
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
 * rclone's "object/directory does not exist" wording. **This must be kept
 * extremely tight**: widening it by one notch has irreversible consequences.
 *
 * The previous `/not found|no such|.../i` was too wide; a 2026-08-01 review
 * measured two bypasses:
 * - `"dial tcp: lookup www.googleapis.com: no such host"` (DNS down) → judged
 *   missing
 * - `"couldn't fetch token: ... no such host"` (auth path down) → judged missing
 *
 * Both make the caller continue with an **empty index** and then write this
 * local batch via `mergeIndexLines("")` — truncating that day's complete cloud
 * index.jsonl down to just this batch. `didn't find section` is even an rclone
 * **configuration** error (the remote name does not exist), likewise an error
 * and not missing.
 *
 * How tight is tight enough: `object not found` / `directory not found` are
 * rclone's own two sentinel error strings (`fs.ErrorObjectNotFound` /
 * `fs.ErrorDirNotFound`), and one of them is what `rclone cat` should report on
 * a day's first upload. **This has not yet been verified on a real machine**,
 * and being too narrow does not merely cost "one skipped flush" — the **first**
 * flush of every day would be judged a read failure, staging would never drain,
 * and the archiver would upload not a single match. So the next real-machine
 * smoke test must confirm this wording first (see docs/pvp-log-archive.md).
 */
const INDEX_MISSING_RE = /\b(object|directory|file) not found\b/i;

/**
 * The three-state result of `rclone cat index.jsonl`.
 *
 * "This day has no index yet" (first upload, normal) MUST be separated from
 * "the read failed" (network/auth/config): the former continues with an empty
 * index, the latter **must abandon this flush** and keep the staging directory —
 * treating a read failure as empty would overwrite the complete cloud index with
 * this local batch, an irreversible deletion.
 */
export function classifyIndexFetch(
  exitCode: number,
  stderr: string,
): "ok" | "missing" | "error" {
  if (exitCode === 0) return "ok";
  if (INDEX_MISSING_RE.test(stderr)) return "missing";
  return "error";
}

/**
 * Confirm before running that rclone is installed and the remote is configured —
 * returns the error message that should be printed, or null when all is well.
 *
 * The cost of skipping this preflight is **one-way**: the archiver would pull
 * ~39,000 matches / 16.5GB out of a volunteer project's GCS onto the local disk
 * and upload not one byte (every match fails to upload → staging only grows →
 * until the 20GB disk guard stops the process). That egress traffic is billed to
 * them and we gain nothing. `syncPvpLogsToDrive.ts:34-59` in this package has
 * done it this way for a while; the archiver copies the same criteria and
 * wording.
 */
export function rclonePreflightError(opts: {
  /** Whether `spawnSync("rclone", ["version"]).error` is non-empty — i.e. there
   *  is no rclone on PATH. */
  rcloneMissing: boolean;
  /** Result of `parseListRemotes(rclone listremotes)`. */
  remotes: readonly string[];
  /** The remote name that will be used (RCLONE_REMOTE). */
  remote: string;
}): string | null {
  if (opts.rcloneMissing) {
    return [
      "未找到 rclone —— 归档器会白下几万场再一个字节都传不上去。一次性安装:",
      "  macOS:  brew install rclone",
      "  Windows: winget install Rclone.Rclone(或 scoop install rclone)",
      "装完重跑本脚本。",
    ].join("\n");
  }
  if (!opts.remotes.includes(opts.remote)) {
    return [
      `rclone 里没有名为 "${opts.remote}" 的 remote(现有:${opts.remotes.join(", ") || "无"})。`,
      "一次性配置:",
      "  rclone config",
      `  → n(新建)→ 名字填 ${opts.remote} → 类型选 drive(Google Drive)`,
      "  → client_id/client_secret 留空 → scope 选 1(drive)→ 一路默认",
      "  → 浏览器弹出 Google 授权,点允许即完成。",
      "配完重跑本脚本。",
    ].join("\n");
  }
  return null;
}
