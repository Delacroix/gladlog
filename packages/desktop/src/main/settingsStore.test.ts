import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";
import {
  SettingsStore,
  type SafeStorageLike,
  type SettingsStoreWarning,
} from "./settingsStore";

/** 真加密不可用,fake 只是可逆的标记变换,足够验证形状/往返逻辑。 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`ENC(${plainText})`),
    decryptString: (buf: Buffer) => {
      const s = buf.toString();
      const m = /^ENC\((.*)\)$/.exec(s);
      if (!m) throw new Error("corrupt ciphertext");
      return m[1];
    },
  };
}

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "gl-settings-")), "settings.json");
}

describe("SettingsStore + safeStorage", () => {
  it("encrypt-on-save: 落盘是 {__enc} 形状,不是明文", () => {
    const path = tmpPath();
    const store = new SettingsStore(path, fakeSafeStorage());
    store.save({ anthropicApiKey: "sk-secret" });
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).not.toBe("sk-secret");
    expect(onDisk.anthropicApiKey).toEqual({ __enc: expect.any(String) });
    expect(typeof onDisk.anthropicApiKey.__enc).toBe("string");
  });

  it("load 解密:save 后 get() 拿回明文", () => {
    const path = tmpPath();
    const store = new SettingsStore(path, fakeSafeStorage());
    store.save({
      anthropicApiKey: "sk-secret",
      deepseekApiKey: "ds-secret",
      obsWebsocketPassword: "hunter2",
    });
    const v = store.get();
    expect(v.anthropicApiKey).toBe("sk-secret");
    expect(v.deepseekApiKey).toBe("ds-secret");
    expect(v.obsWebsocketPassword).toBe("hunter2");
  });

  it("旧版明文迁移:明文可以直接读出,save 一次后落盘变成加密", () => {
    const path = tmpPath();
    // 手写一份旧版明文 settings.json(未经过本类写入)。
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ anthropicApiKey: "legacy-plain" }));
    const store = new SettingsStore(path, fakeSafeStorage());

    // 迁移前:直接读明文,无损。
    expect(store.get().anthropicApiKey).toBe("legacy-plain");

    // 保存(哪怕是无关字段的 patch)之后,落盘应变成加密形状。
    store.save({ wowDirectory: "/wow" });
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).toEqual({ __enc: expect.any(String) });
    // 且解密后仍是原值,没有数据丢失。
    expect(store.get().anthropicApiKey).toBe("legacy-plain");
  });

  it("safeStorage 不可用:保持明文行为 + 恰好一次 warn", () => {
    const path = tmpPath();
    const warns: SettingsStoreWarning[] = [];
    const store = new SettingsStore(path, fakeSafeStorage(false), (w) =>
      warns.push(w),
    );
    store.save({ anthropicApiKey: "sk-secret" });
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).toBe("sk-secret"); // 明文落盘
    expect(store.get().anthropicApiKey).toBe("sk-secret");

    // 再存一次密钥字段,不应重复 warn。
    store.save({ deepseekApiKey: "ds-secret" });
    const unavailableWarnings = warns.filter(
      (w) => w.kind === "encryption-unavailable",
    );
    expect(unavailableWarnings).toHaveLength(1);
  });

  it("解密失败(损坏值/密钥库变更):降级空串 + warn,不抛出", () => {
    const path = tmpPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ anthropicApiKey: { __enc: "not-valid-ciphertext" } }),
    );
    const warns: SettingsStoreWarning[] = [];
    const store = new SettingsStore(path, fakeSafeStorage(true), (w) =>
      warns.push(w),
    );
    let v: ReturnType<typeof store.get> | undefined;
    expect(() => {
      v = store.get();
    }).not.toThrow();
    expect(v?.anthropicApiKey).toBe("");
    expect(warns.some((w) => w.kind === "decrypt-failed")).toBe(true);
  });

  it("哨兵往返在加密存储上依然成立(redact/sanitize 作用于解密后的明文)", async () => {
    const { redactSettings, sanitizeSettingsPatch } =
      await import("./settingsStore");
    const { OBS_PASSWORD_REDACTED } = await import("../shared/protocol");
    const path = tmpPath();
    const store = new SettingsStore(path, fakeSafeStorage());
    store.save({ obsWebsocketPassword: "hunter2" });
    const decrypted = store.get();
    expect(redactSettings(decrypted).obsWebsocketPassword).toBe(
      OBS_PASSWORD_REDACTED,
    );
    // 哨兵值不应被当作新密码回写覆盖已存的加密值。
    const patch = sanitizeSettingsPatch({
      obsWebsocketPassword: OBS_PASSWORD_REDACTED,
    });
    expect(patch).not.toHaveProperty("obsWebsocketPassword");
    store.save(patch);
    expect(store.get().obsWebsocketPassword).toBe("hunter2");
  });

  it("未注入 safeStorage 时默认降级为明文(向后兼容既有调用方)", () => {
    const path = tmpPath();
    const store = new SettingsStore(path); // 无第二个参数,走 NOOP 替身
    store.save({ anthropicApiKey: "sk-secret" });
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).toBe("sk-secret");
    expect(store.get().anthropicApiKey).toBe("sk-secret");
  });
});
