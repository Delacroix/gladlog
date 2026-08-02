import { isAbsolute } from "path";

/**
 * The userData directory in E2E mode. The switch does exactly one thing: move
 * the state directory to a temporary path so end-to-end tests run on clean,
 * disposable state.
 *
 * When enabled without a valid path it **throws instead of falling back** —
 * silently using the real userData would let tests pollute user data.
 */
export function e2eUserDataDir(env: NodeJS.ProcessEnv): string | null {
  if (env["GLADLOG_E2E"] !== "1") return null;
  const dir = env["GLADLOG_E2E_USER_DATA"];
  if (!dir || !isAbsolute(dir)) {
    throw new Error(
      "GLADLOG_E2E=1 需要 GLADLOG_E2E_USER_DATA 指向一个绝对路径",
    );
  }
  return dir;
}
