import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SettingsStore,
  API_KEY_REDACTED,
  redactSettings,
  sanitizeSettingsPatch,
} from "../src/main/settingsStore";

const dir = () => mkdtempSync(join(tmpdir(), "gl-settings-"));

describe("SettingsStore", () => {
  it("缺失文件 → 默认值", () => {
    const s = new SettingsStore(join(dir(), "settings.json"));
    expect(s.get()).toEqual({
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
      autoCheckUpdates: true,
      lastSeenVersion: null,
      deepDiveSnapshot: false,
    });
  });
  it("save 合并并持久化;文件为合法 JSON", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.save({ wowDirectory: "/tmp/wow" }).wowDirectory).toBe("/tmp/wow");
    expect(new SettingsStore(p).get().wowDirectory).toBe("/tmp/wow");
    expect(JSON.parse(readFileSync(p, "utf-8")).anthropicApiKey).toBeNull();
  });
  it("autoAnalyzeNew:默认 false;save 往返持久化", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.get().autoAnalyzeNew).toBe(false);
    expect(s.save({ autoAnalyzeNew: true }).autoAnalyzeNew).toBe(true);
    expect(new SettingsStore(p).get().autoAnalyzeNew).toBe(true);
  });
  it("autoCheckUpdates:默认 true;lastSeenVersion:默认 null;两者 save 往返持久化", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.get().autoCheckUpdates).toBe(true);
    expect(s.get().lastSeenVersion).toBeNull();
    expect(
      s.save({ autoCheckUpdates: false, lastSeenVersion: "0.1.20" })
        .autoCheckUpdates,
    ).toBe(false);
    const reread = new SettingsStore(p).get();
    expect(reread.autoCheckUpdates).toBe(false);
    expect(reread.lastSeenVersion).toBe("0.1.20");
  });
  it("deepDiveSnapshot:默认 false;save 往返持久化", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.get().deepDiveSnapshot).toBe(false);
    expect(s.save({ deepDiveSnapshot: true }).deepDiveSnapshot).toBe(true);
    expect(new SettingsStore(p).get().deepDiveSnapshot).toBe(true);
  });
  it("settings:deepDiveSnapshot 默认 false;patch 非 boolean 被丢弃", () => {
    const p = join(dir(), "settings.json");
    const s = new SettingsStore(p);
    expect(s.get().deepDiveSnapshot).toBe(false);
    expect(
      sanitizeSettingsPatch({
        deepDiveSnapshot: "yes" as unknown as boolean,
        wowDirectory: "/x",
      }),
    ).toEqual({ wowDirectory: "/x" });
  });
  it("sanitizeSettingsPatch 对这两个字段是透传(黑名单式校验器,无需改)", () => {
    expect(
      sanitizeSettingsPatch({
        autoCheckUpdates: false,
        lastSeenVersion: "1.2.3",
      }),
    ).toEqual({ autoCheckUpdates: false, lastSeenVersion: "1.2.3" });
  });
  it("redactSettings 不动这两个字段(非密字段展开式透传)", () => {
    const s = new SettingsStore(join(dir(), "settings.json")).get();
    const redacted = redactSettings({
      ...s,
      anthropicApiKey: "sk-real",
      autoCheckUpdates: false,
      lastSeenVersion: "0.1.20",
    });
    expect(redacted.autoCheckUpdates).toBe(false);
    expect(redacted.lastSeenVersion).toBe("0.1.20");
    expect(redacted.anthropicApiKey).toBe(API_KEY_REDACTED);
  });
  it("损坏 JSON → 回退默认,不抛", () => {
    const p = join(dir(), "settings.json");
    writeFileSync(p, "{not json");
    expect(new SettingsStore(p).get().wowDirectory).toBeNull();
  });
  it("旧版单字段 anthropicModel 迁进 aiModels.anthropic", () => {
    const p = join(dir(), "settings.json");
    writeFileSync(p, JSON.stringify({ anthropicModel: "claude-opus-4-8" }));
    expect(new SettingsStore(p).get().aiModels).toEqual({
      anthropic: "claude-opus-4-8",
    });
  });
  it("旧字段是自由文本,非白名单值丢弃而不是带毒迁移", () => {
    const p = join(dir(), "settings.json");
    writeFileSync(
      p,
      JSON.stringify({ anthropicModel: "claude-3-opus-legacy" }),
    );
    expect(new SettingsStore(p).get().aiModels).toEqual({});
  });
});

describe("settings 脱敏(key 永不出主进程)", () => {
  it("redactSettings:有 key → 哨兵(保真值);无 key → null", () => {
    const base = {
      wowDirectory: "/tmp/wow",
      anthropicApiKey: "sk-real-secret",
      deepseekApiKey: "sk-ds-secret",
      aiModels: {},
      aiBackend: "anthropic" as const,
      aiBackendCommand: null,
      aiLanguage: "zh" as const,
      autoAnalyzeNew: false,
      recordingEnabled: false,
      obsWebsocketUrl: null,
      obsWebsocketPassword: null,
      recordingKeepCount: 50,
      autoCheckUpdates: true,
      lastSeenVersion: null,
      deepDiveSnapshot: false,
    };
    const redacted = redactSettings(base);
    expect(redacted.anthropicApiKey).toBe(API_KEY_REDACTED);
    expect(redacted.anthropicApiKey).not.toContain("sk-real");
    expect(redacted.deepseekApiKey).not.toContain("sk-ds");
    expect(!!redacted.anthropicApiKey).toBe(true);
    expect(redacted.wowDirectory).toBe("/tmp/wow");
    expect(
      redactSettings({ ...base, anthropicApiKey: null }).anthropicApiKey,
    ).toBeNull();
  });
  it("sanitizeSettingsPatch:哨兵回写被丢弃,真 key 保留", () => {
    expect(
      sanitizeSettingsPatch({
        anthropicApiKey: API_KEY_REDACTED,
        wowDirectory: "/x",
      }),
    ).toEqual({ wowDirectory: "/x" });
    expect(sanitizeSettingsPatch({ anthropicApiKey: "sk-new" })).toEqual({
      anthropicApiKey: "sk-new",
    });
  });
  it("sanitizeSettingsPatch:模型逐格按后端白名单校验,非法格丢弃", () => {
    expect(
      sanitizeSettingsPatch({
        aiModels: {
          anthropic: "claude-opus-4-8", // 合法
          agy: "claude-opus-4-8", // agy 用别名,这是 Anthropic id → 丢
          claudeCli: "claude-sonnet-5", // 合法
        },
      }),
    ).toEqual({
      aiModels: {
        anthropic: "claude-opus-4-8",
        claudeCli: "claude-sonnet-5",
      },
    });
  });
});
