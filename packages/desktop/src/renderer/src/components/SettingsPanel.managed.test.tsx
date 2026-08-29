// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { bridge } from "../bridge";

vi.mock("../bridge");

type Settings = Record<string, unknown>;
type InstallState = { installed: boolean; platformSupported: boolean };
type InstallProgress = {
  phase: "downloading" | "verifying" | "extracting" | "done";
  loaded?: number;
  total?: number;
};

const baseSettings: Settings = {
  wowDirectory: null,
  anthropicApiKey: null,
  deepseekApiKey: null,
  aiModels: {},
  aiBackend: "anthropic",
  aiBackendCommand: null,
  aiLanguage: "zh",
  autoAnalyzeNew: false,
  recordingEnabled: false,
  obsWebsocketUrl: null,
  obsWebsocketPassword: null,
  recordingKeepCount: 50,
  recordingMaxBytes: 80 * 1024 ** 3,
  recordingMode: "managed",
  managedWsPassword: null,
};

function mountWith(opts: {
  settings?: Settings;
  installState?: InstallState;
  installObs?: () => Promise<{ ok: boolean; error?: string }>;
  onInstallProgress?: (cb: (p: InstallProgress) => void) => () => void;
}) {
  const settings: Settings = { ...baseSettings, ...opts.settings };
  const save = vi.fn(async (partial: Settings) => {
    Object.assign(settings, partial);
    return { ...settings };
  });
  let progressCb: ((p: InstallProgress) => void) | undefined;
  const onInstallProgress =
    opts.onInstallProgress ??
    vi.fn((cb: (p: InstallProgress) => void) => {
      progressCb = cb;
      return () => {};
    });
  const installObs = opts.installObs ?? vi.fn(async () => ({ ok: true }));
  (bridge as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    settings: {
      get: vi.fn().mockResolvedValue({ ...settings }),
      save,
    },
    recorder: {
      getStatus: vi.fn().mockResolvedValue({
        enabled: false,
        connected: false,
        recording: false,
        lastError: null,
        sourceActive: null,
      }),
      onStatus: vi.fn().mockReturnValue(() => {}),
      testConnection: vi.fn(),
      autoConfig: vi.fn(),
      getForMatch: vi.fn(),
      getObsInstallState: vi
        .fn()
        .mockResolvedValue(
          opts.installState ?? { installed: false, platformSupported: true },
        ),
      onInstallProgress,
      installObs,
    },
    app: { openExternal: vi.fn() },
  });
  const { container } = render(<SettingsPanel />);
  return { save, installObs, getProgressCb: () => progressCb, container };
}

beforeEach(() => vi.clearAllMocks());

describe("SettingsPanel 录像模式(task-6)", () => {
  it("managed + 未安装 → 显示下载按钮(含 MB 数),隐藏一期 WebSocket 表单", async () => {
    const { container } = mountWith({
      installState: { installed: false, platformSupported: true },
    });
    await screen.findByRole("button", { name: /下载并启用/ });
    expect(container.textContent).toMatch(/\d+MB/);
    expect(screen.queryByLabelText("OBS WebSocket 地址")).toBeNull();
  });

  it("managed + 已安装 → 不显示下载按钮,显示已安装说明", async () => {
    mountWith({ installState: { installed: true, platformSupported: true } });
    await screen.findByText(/已安装并自动管理/);
    expect(screen.queryByRole("button", { name: /下载并启用/ })).toBeNull();
  });

  it("external 模式 → 显示一期 WebSocket 表单,隐藏下载相关 UI", async () => {
    mountWith({
      settings: { recordingMode: "external" },
      installState: { installed: false, platformSupported: true },
    });
    await screen.findByLabelText("OBS WebSocket 地址");
    expect(screen.queryByRole("button", { name: /下载并启用/ })).toBeNull();
  });

  it("下载中:onInstallProgress 推送的进度按百分比渲染", async () => {
    const { getProgressCb } = mountWith({
      installState: { installed: false, platformSupported: true },
      installObs: vi.fn(
        () =>
          new Promise<{ ok: boolean; error?: string }>(() => {
            /* never resolves within this test -- we only care about the
             * progress push while "downloading" */
          }),
      ),
    });
    const dl = await screen.findByRole("button", { name: /下载并启用/ });
    fireEvent.click(dl);
    await waitFor(() => expect(getProgressCb()).toBeTruthy());
    act(() => {
      getProgressCb()!({ phase: "downloading", loaded: 50, total: 100 });
    });
    await waitFor(() => expect(screen.getByText(/50%/)).toBeTruthy());
  });

  it("下载失败 → 显示错误原文,按钮文案变重试", async () => {
    mountWith({
      installState: { installed: false, platformSupported: true },
      installObs: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "网络错误 ECONNRESET" }),
    });
    const dl = await screen.findByRole("button", { name: /下载并启用/ });
    fireEvent.click(dl);
    await waitFor(() => expect(screen.getByText(/ECONNRESET/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "重试" }).textContent).toBe(
      "重试",
    );
  });

  it("非 win32:managed 选项禁用 + 说明文案;选中态落在 external,即便存储的默认值仍是 managed(复核 NEW-7)", async () => {
    mountWith({
      settings: { recordingMode: "managed" }, // stored default, untouched
      installState: { installed: false, platformSupported: false },
    });
    await screen.findByText("托管录像仅支持 Windows");
    const managedBtn = screen.getByRole("radio", {
      name: "自动下载并管理 OBS,无需安装",
    });
    const externalBtn = screen.getByRole("radio", {
      name: "使用我自己的 OBS",
    });
    expect((managedBtn as HTMLButtonElement).disabled).toBe(true);
    expect(managedBtn.className).not.toContain("active");
    expect(externalBtn.className).toContain("active");
    // And the external-only form is what actually renders (effective mode).
    await screen.findByLabelText("OBS WebSocket 地址");
  });
});
