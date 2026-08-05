/**
 * Managed-OBS asset identity: pinned release version, download URL, expected
 * SHA-256, and expected byte size. Verified against the real GitHub release
 * and a real Windows machine on 2026-08-04 — do not bump without re-verifying
 * both. Single source: gate scripts (task 3/7) import these instead of
 * hardcoding copies (shared-predicate rule, CLAUDE.md).
 */
export const OBS_VERSION = "32.2.1";
export const OBS_ZIP_URL = `https://github.com/obsproject/obs-studio/releases/download/${OBS_VERSION}/OBS-Studio-${OBS_VERSION}-Windows-x64.zip`;
export const OBS_ZIP_SHA256 =
  "db64a2934f8261f85b1410b84be011207a0afda5400d008289f1f1e211bcc7de";
export const OBS_ZIP_BYTES = 187_817_017;
/** Managed instance's websocket port. 4466 (design doc 2.4): far from the
 * user's own OBS default 4455, verified free on the real machine. */
export const MANAGED_WS_PORT = 4466;

/** true = extract this zip entry. Blacklist style: default-extract, skip only
 * the known-big, known-unneeded payloads (CEF, pdb, scripting, extra locales).
 * ACCEPTS BOTH SEPARATORS — callers hand it paths from a directory walk, which
 * on win32 uses backslashes. */
export function shouldExtract(entryPath: string): boolean {
  const p = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/\.pdb$/i.test(p)) return false;
  if (/^obs-plugins\/64bit\/locales\//.test(p)) return false;
  if (
    /^obs-plugins\/64bit\/(libcef\.dll|chrome_elf\.dll|libEGL\.dll|libGLESv2\.dll|snapshot_blob\.bin|v8_context_snapshot\.bin|icudtl\.dat|vk_swiftshader.*|vulkan-1\.dll|.*\.pak)$/i.test(
      p,
    )
  )
    return false;
  if (/^obs-plugins\/64bit\/obs-browser/i.test(p)) return false;
  if (/^bin\/64bit\/obs-browser-page\.exe$/i.test(p)) return false;
  if (/^data\/obs-scripting\//.test(p)) return false;
  const loc = /^data\/obs-studio\/locale\/(.+)\.ini$/.exec(p);
  if (loc) return loc[1] === "en-US" || loc[1] === "zh-CN";
  return true;
}
