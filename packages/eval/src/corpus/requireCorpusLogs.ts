/**
 * Shared fail-fast guard for the two scripts that read a directory of raw
 * combat logs (`pipelineFuzz.ts`, `modelFormatAudit.ts`).
 *
 * Both used to hardcode `$GLADLOG_EVAL_HOME/corpus/fuzz-1000` — 1,000 wild
 * 2026-07 (pre-12.1) logs harvested for the thousand-match fuzz. That
 * directory was deleted from the eval repo's working tree in 2026-08, so both
 * scripts died on `readdir` with a bare ENOENT that named a path and nothing
 * else. One place, one message, naming the directory and every way out.
 */
import fs from "fs-extra";

/** Default corpus directory both scripts fall back to when `--corpus` is absent. */
export function defaultFuzzCorpusDir(evalHome: string): string {
  return `${evalHome}/corpus/fuzz-1000`;
}

export async function requireCorpusLogs(
  dir: string,
  script: string,
): Promise<string[]> {
  const files = (await fs.pathExists(dir))
    ? (await fs.readdir(dir)).filter((f: string) => f.endsWith(".txt"))
    : [];
  if (files.length > 0) return files;
  console.error(
    [
      `${script}: no .txt combat logs under ${dir}`,
      "",
      "  The historical default, $GLADLOG_EVAL_HOME/corpus/fuzz-1000 (1,000 wild",
      "  2026-07 pre-12.1 logs), was deleted from the eval repo's working tree in",
      "  2026-08 and no manifest regenerates it. Pick one:",
      "",
      "    * re-harvest it (downloads from the public feed; slow):",
      "        npx tsx packages/eval/scripts/pipelineFuzz.ts --count 1000",
      "    * point at a corpus you already have:",
      "        --corpus <dir of raw .txt logs>",
      "      e.g. $GLADLOG_EVAL_HOME/corpus/public-dps, or a directory materialised",
      "      from $GLADLOG_EVAL_HOME/corpus/manifest-archive-2026-08-28-newseason.txt",
      "      (the current-season archive manifest; its entries are .gz and must be",
      "      gunzipped first).",
    ].join("\n"),
  );
  process.exit(2);
}
