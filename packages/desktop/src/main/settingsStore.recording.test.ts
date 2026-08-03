import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { OBS_PASSWORD_REDACTED } from "../shared/protocol";
import {
  redactSettings,
  sanitizeSettingsPatch,
  SettingsStore,
} from "./settingsStore";

describe("recording settings", () => {
  it("旧配置文件读回带默认值", () => {
    const s = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "settings.json"),
    );
    const v = s.get();
    expect(v.recordingEnabled).toBe(false);
    expect(v.recordingKeepCount).toBe(50);
    expect(v.obsWebsocketUrl).toBeNull();
  });

  it("redact:密码替换为哨兵;null 保持 null", () => {
    const base = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "s.json"),
    ).get();
    expect(
      redactSettings({ ...base, obsWebsocketPassword: "hunter2" })
        .obsWebsocketPassword,
    ).toBe(OBS_PASSWORD_REDACTED);
    expect(redactSettings(base).obsWebsocketPassword).toBeNull();
  });

  it("sanitize:哨兵不回写;keepCount 非法值丢弃", () => {
    expect(
      sanitizeSettingsPatch({ obsWebsocketPassword: OBS_PASSWORD_REDACTED }),
    ).not.toHaveProperty("obsWebsocketPassword");
    expect(
      sanitizeSettingsPatch({ recordingKeepCount: -3 }),
    ).not.toHaveProperty("recordingKeepCount");
    expect(
      sanitizeSettingsPatch({ recordingKeepCount: Number.NaN }),
    ).not.toHaveProperty("recordingKeepCount");
    expect(sanitizeSettingsPatch({ recordingKeepCount: 10 })).toEqual({
      recordingKeepCount: 10,
    });
  });

  it("recordingMaxBytes 默认 80GB;非法值丢弃", () => {
    const s = new SettingsStore(
      join(mkdtempSync(join(tmpdir(), "gl-")), "settings.json"),
    );
    expect(s.get().recordingMaxBytes).toBe(80 * 1024 ** 3);
    expect(sanitizeSettingsPatch({ recordingMaxBytes: -1 })).not.toHaveProperty(
      "recordingMaxBytes",
    );
    expect(
      sanitizeSettingsPatch({ recordingMaxBytes: Number.NaN }),
    ).not.toHaveProperty("recordingMaxBytes");
    expect(sanitizeSettingsPatch({ recordingMaxBytes: 1024 })).toEqual({
      recordingMaxBytes: 1024,
    });
  });
});
