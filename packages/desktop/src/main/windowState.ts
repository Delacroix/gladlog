import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * 主窗口 bounds 记忆(UI 改版 2026-08-01):双栏布局 ≥1440px 才生效,
 * 而旧默认 1200×800 永远触发不了 —— 记住用户上次的窗口尺寸/位置,
 * 4K 屏拉满一次后每次都以大窗口打开。
 *
 * 独立 window-state.json,不进 settings.json:SettingsStore 有密钥
 * 加密/掩码不变式,窗口几何这种高频写入不该跟它耦合。
 * 保持 electron-free(路径由调用方注入),同 settingsStore 的单测法。
 */
export interface WindowState {
  width: number;
  height: number;
  /** 无 x/y = 交给系统居中(首启,或上次位置已不在任何屏幕上)。 */
  x?: number;
  y?: number;
  maximized: boolean;
}

/** 与 createWindow 的 minWidth/minHeight 同值 —— 读回的持久档不能低于它。 */
export const MIN_WINDOW = { width: 900, height: 600 } as const;

export function loadWindowState(filePath: string): WindowState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null; // 首启无档/损坏 → 走默认
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const width = num(o["width"]);
  const height = num(o["height"]);
  if (width === null || height === null) return null;
  const state: WindowState = {
    width: Math.max(MIN_WINDOW.width, Math.round(width)),
    height: Math.max(MIN_WINDOW.height, Math.round(height)),
    maximized: o["maximized"] === true,
  };
  const x = num(o["x"]);
  const y = num(o["y"]);
  if (x !== null && y !== null) {
    state.x = Math.round(x);
    state.y = Math.round(y);
  }
  return state;
}

export function saveWindowState(filePath: string, state: WindowState): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, filePath); // 同 settingsStore:原子替换,半截文件不落盘
  } catch {
    // 写失败只损失一次记忆,下次关窗还会再写 —— 不值得让退出流程抛错
  }
}
