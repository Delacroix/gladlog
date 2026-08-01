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
 * rclone「对象/目录不存在」的文案。**必须收得死紧**:判宽一格的代价是不可逆的。
 *
 * 原先的 `/not found|no such|.../i` 过宽,2026-08-01 复核实测两条旁路:
 * - `"dial tcp: lookup www.googleapis.com: no such host"`(DNS 挂了)→ 判 missing
 * - `"couldn't fetch token: ... no such host"`(鉴权链路挂了)→ 判 missing
 *
 * 两者都会让调用方按**空索引**继续,再把本地这一批 `mergeIndexLines("")` 写上去 ——
 * 云端当天完整的 index.jsonl 就被截断成只剩这一批。`didn't find section` 更是
 * rclone **配置**错误(remote 名不存在),同样是 error 不是 missing。
 *
 * 收到什么程度为止:`object not found` / `directory not found` 是 rclone 自己的两个
 * sentinel 错误文案(`fs.ErrorObjectNotFound` / `fs.ErrorDirNotFound`),某一天首次
 * 上传时 `rclone cat` 报的就该是它们之一。**这一点尚未在真机上核对过**,而收得过窄
 * 的后果不是「少赚一次冲刷」——每一天的**首次**冲刷都会被判成读失败,暂存永不排空,
 * 归档器一场也传不上去。所以下次真机冒烟必须先把这条文案对上(见 docs/pvp-log-archive.md)。
 */
const INDEX_MISSING_RE = /\b(object|directory|file) not found\b/i;

/**
 * `rclone cat index.jsonl` 的三态结果。
 *
 * 必须把「这一天还没有索引」(首次上传,正常)与「读失败」(网络/鉴权/配置)分开:
 * 前者按空索引继续,后者**必须放弃本次冲刷**并保留暂存 —— 把读失败当空处理,
 * 就会用本地这一批覆盖掉云端完整的索引,那是不可逆的删除。
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
 * 跑之前先确认 rclone 装了、remote 配了 —— 返回该打印的错误信息,没问题则 null。
 *
 * 不预检的代价是**单向**的:归档器会把 ~39,000 场、16.5GB 从志愿者项目的 GCS
 * 全量下到本地,一个字节也传不上去(每场都上传失败 → 暂存只涨不清 → 直到 20GB
 * 磁盘保护把进程停掉)。这笔出口流量记在对方账上,而我们什么都没得到。
 * 同包 `syncPvpLogsToDrive.ts:34-59` 早就是这么做的,归档器照搬同一套判据与文案。
 */
export function rclonePreflightError(opts: {
  /** `spawnSync("rclone", ["version"]).error` 是否非空 —— 即 PATH 上没有 rclone。 */
  rcloneMissing: boolean;
  /** `parseListRemotes(rclone listremotes)` 的结果。 */
  remotes: readonly string[];
  /** 需要用到的 remote 名(RCLONE_REMOTE)。 */
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
