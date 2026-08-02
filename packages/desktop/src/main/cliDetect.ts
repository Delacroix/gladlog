import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import { BACKEND_CLI_TOOL, type AiBackend } from "../shared/aiModels";

const execFileP = promisify(execFile);

/** Local CLIs we can detect; `node` exists only to resolve the interpreter for
 *  agy's .mjs compatibility mode (when a wrapper-script path is filled in by
 *  hand) and does not correspond to any backend. The backend → tool-name map
 *  lives in BACKEND_CLI_TOOL in shared/aiModels.ts (shared with the renderer's
 *  copy). */
export type LocalCliTool = "claude" | "agy" | "codex" | "node";

export interface CliDetectDeps {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  /** PATH lookup (login shell on mac, `where` on win); injected by tests. */
  pathLookup?: (tool: string) => Promise<string | null>;
}

/**
 * Fallback list of common install locations outside PATH. A packaged GUI app
 * (especially launched from the Dock on mac or from Explorer on win) does not
 * necessarily inherit the user's shell PATH, so "not on PATH" does not mean
 * "not installed" — probe each tool's mainstream install locations one by one.
 */
export function wellKnownCliCandidates(
  tool: LocalCliTool,
  opts: {
    platform: NodeJS.Platform;
    home: string;
    env: Record<string, string | undefined>;
  },
): string[] {
  // Pick the separator by target platform (never the host platform's join:
  // unit tests build win paths while running on mac)
  const j = opts.platform === "win32" ? win32.join : posix.join;
  if (opts.platform === "win32") {
    return [
      // Both install styles for claude/agy: the native installer and npm global
      j(opts.home, ".local", "bin", `${tool}.exe`),
      ...(opts.env.APPDATA ? [j(opts.env.APPDATA, "npm", `${tool}.cmd`)] : []),
    ];
  }
  return [
    j(opts.home, ".local", "bin", tool),
    `/opt/homebrew/bin/${tool}`,
    `/usr/local/bin/${tool}`,
  ];
}

/**
 * Pick the real executable path out of the PATH-lookup command's stdout. A
 * login shell's .zprofile/.zshrc may print banners or nvm loading notices to
 * stdout (agy flash review #2), and a naive trim would treat the whole
 * "Welcome!\n/opt/homebrew/bin/claude" blob as the path → ENOENT.
 * Criteria: absolute path + basename starting with the tool name
 * (claude / claude.exe / claude.cmd) + the file actually exists.
 */
export function pickCliPathFromLookupOutput(
  stdout: string,
  tool: string,
  opts: { platform: NodeJS.Platform; exists: (p: string) => boolean },
): string | null {
  const isWin = opts.platform === "win32";
  const isAbs = isWin ? /^[A-Za-z]:[\\/]/ : /^\//;
  const base = isWin ? win32.basename : posix.basename;
  return (
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(
        (l) =>
          isAbs.test(l) &&
          base(l).toLowerCase().startsWith(tool.toLowerCase()) &&
          opts.exists(l),
      ) ?? null
  );
}

function defaultPathLookup(
  tool: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): Promise<string | null> {
  const pick = (stdout: string) =>
    pickCliPathFromLookupOutput(stdout, tool, { platform, exists });
  if (platform === "win32") {
    // Windows has no login-shell concept, so use `where` to get an absolute
    // path (an npm global install produces claude.cmd, and spawning the bare
    // name gives ENOENT).
    return execFileP("where", [tool])
      .then((r) => pick(r.stdout))
      .catch(() => null);
  }
  // A packaged mac GUI app does not inherit the shell PATH, so resolve through
  // the user's login shell.
  const shell = env.SHELL || "/bin/zsh";
  return execFileP(shell, ["-lc", `command -v ${tool}`])
    .then((r) => pick(r.stdout))
    .catch(() => null);
}

/**
 * Auto-detect a local CLI's absolute path: PATH first, common install
 * directories as fallback, null when neither finds it. Callers decide what
 * null means (the backend throws an explicit error / the settings page shows
 * "not detected").
 */
export async function detectLocalCli(
  tool: LocalCliTool,
  deps?: CliDetectDeps,
): Promise<string | null> {
  const platform = deps?.platform ?? process.platform;
  const home = deps?.home ?? homedir();
  const env = deps?.env ?? process.env;
  const exists = deps?.exists ?? existsSync;
  const lookup =
    deps?.pathLookup ??
    ((t: string) => defaultPathLookup(t, platform, env, exists));

  const fromPath = await lookup(tool);
  if (fromPath) return fromPath;
  for (const c of wellKnownCliCandidates(tool, { platform, home, env })) {
    if (exists(c)) return c;
  }
  return null;
}

// Cache for the analysis hot path: do not spawn a shell over and over within
// one process. The settings page's detect IPC always runs fresh (it neither
// reads nor writes this cache) — a user who just installed the CLI and comes
// back to the settings page must see the change immediately.
const detected = new Map<LocalCliTool, Promise<string | null>>();
export function detectLocalCliCached(
  tool: LocalCliTool,
): Promise<string | null> {
  let p = detected.get(tool);
  if (!p) {
    p = detectLocalCli(tool).then((r) => {
      // Do not cache failures (agy flash review #6): once the user installs
      // the CLI the very next analysis works, with no detour through the
      // settings page or a restart; the only cost is one extra shell lookup
      // per attempt while it is missing.
      if (r === null) detected.delete(tool);
      return r;
    });
    detected.set(tool, p);
  }
  return p;
}

/** Settings-page IPC: detect by backend, always fresh. Non-local backend →
 *  null. */
export async function detectCliForBackend(
  backend: string,
): Promise<{ path: string | null }> {
  const tool = BACKEND_CLI_TOOL[backend as AiBackend];
  if (!tool) return { path: null };
  const path = await detectLocalCli(tool);
  // On success, refresh the cache while we are here: what the settings page
  // shows stays consistent with what later analyses actually use. Failures are
  // likewise not cached (same semantics as detectLocalCliCached).
  if (path) detected.set(tool, Promise.resolve(path));
  else detected.delete(tool);
  return { path };
}

// Audit #21 item6: local CLI backends had no version probe, so when an old
// binary failed on an incompatible protocol the user saw only raw stderr and
// could not tell whether it was a version problem. Add a one-shot,
// non-blocking, lightweight probe and carry its result (version number /
// probe failed) into the error message. No version gate and no compatibility
// matrix — just one more attribution clue.
export type CliVersionProbe = { ok: true; version: string } | { ok: false };

const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Take the first non-empty line of `--version` output and prefer a version
 *  number of the 1.2.3 shape; if none can be extracted, fall back to the whole
 *  line (truncated to 40 chars so an absurdly long output cannot leak
 *  through). All whitespace → null (treated as a failed probe, not as "the
 *  version is the empty string"). */
export function parseCliVersionOutput(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const m = line.match(/\d+(?:\.\d+){1,3}[-.\w]*/);
  return (m ? m[0] : line).slice(0, 40);
}

/**
 * Lightweight version probe: `<cmd> --version` with a 5s timeout. Any failure
 * (refused to execute / timed out / non-zero exit, depending on the caller's
 * exec implementation) or an unparseable version → `{ ok: false }`. Never
 * throws, never blocks the caller.
 */
export async function probeCliVersion(
  cmd: string,
  opts?: {
    exec?: (
      cmd: string,
      args: string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  },
): Promise<CliVersionProbe> {
  const exec =
    opts?.exec ??
    ((c: string, args: string[]) =>
      execFileP(c, args, { timeout: CLI_VERSION_PROBE_TIMEOUT_MS }));
  try {
    const { stdout, stderr } = await exec(cmd, ["--version"]);
    const version =
      parseCliVersionOutput(stdout) ?? parseCliVersionOutput(stderr);
    return version ? { ok: true, version } : { ok: false };
  } catch {
    return { ok: false };
  }
}

// tool → probe-result promise; a given tool is probed only once per process
// ("probe once when the backend is selected / first used") — the caller
// (requireCli in localAiBackends.ts) fires it off and forgets after resolving
// the path, and later error messages reuse this cached result instead of
// probing again. Tests use a different tool per case, so no separate
// cache-reset hook is needed.
const versionProbes = new Map<LocalCliTool, Promise<CliVersionProbe>>();
export function probeCliVersionCached(
  tool: LocalCliTool,
  cmd: string,
  opts?: Parameters<typeof probeCliVersion>[1],
): Promise<CliVersionProbe> {
  let p = versionProbes.get(tool);
  if (!p) {
    p = probeCliVersion(cmd, opts);
    versionProbes.set(tool, p);
  }
  return p;
}
