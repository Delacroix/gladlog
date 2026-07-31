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

  it("旧版明文迁移:明文可以直接读出,该字段本身被 save 时才变成加密", () => {
    const path = tmpPath();
    // 手写一份旧版明文 settings.json(未经过本类写入)。
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ anthropicApiKey: "legacy-plain" }));
    const store = new SettingsStore(path, fakeSafeStorage());

    // 迁移前:直接读明文,无损。
    expect(store.get().anthropicApiKey).toBe("legacy-plain");

    // 迁移只在该字段本身出现在 patch 里时发生(值不变也算“出现”)。
    store.save({ anthropicApiKey: "legacy-plain" });
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).toEqual({ __enc: expect.any(String) });
    // 且解密后仍是原值,没有数据丢失。
    expect(store.get().anthropicApiKey).toBe("legacy-plain");
  });

  it("回归(复核 Critical):旧版明文字段未被 patch 触及时,无关 save() 不强制迁移", () => {
    const path = tmpPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ anthropicApiKey: "legacy-plain" }));
    const store = new SettingsStore(path, fakeSafeStorage());

    store.save({ wowDirectory: "/wow" }); // 无关字段
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    // 未被 patch 命中——原样保留明文,不被顺带加密,也绝不能被清空。
    expect(onDisk.anthropicApiKey).toBe("legacy-plain");
    expect(store.get().anthropicApiKey).toBe("legacy-plain");
  });

  it("回归(复核 Critical,红→绿 1/2):无关 save() 不清空磁盘上损坏的密文——原样保留,不因解密失败被抹成空串", () => {
    const path = tmpPath();
    mkdirSync(dirname(path), { recursive: true });
    const corrupt = { __enc: "not-valid-ciphertext" };
    writeFileSync(path, JSON.stringify({ anthropicApiKey: corrupt }));
    const store = new SettingsStore(path, fakeSafeStorage(true));

    store.save({ wowDirectory: "/wow" }); // 无关字段,不碰 anthropicApiKey
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.anthropicApiKey).toEqual(corrupt); // 逐字节原样保留
  });

  it("回归(复核 Critical,红→绿 2/2):无关 save() 不清空磁盘上合法的密文,即便当下 safeStorage 暂时不可用(如锁屏钥匙串)", () => {
    const path = tmpPath();
    const writeStore = new SettingsStore(path, fakeSafeStorage(true));
    writeStore.save({ anthropicApiKey: "sk-secret" });
    const before = JSON.parse(readFileSync(path, "utf-8"));
    expect(before.anthropicApiKey).toEqual({ __enc: expect.any(String) });

    // 同一份文件,换一个当下 safeStorage 不可用的 store 实例做无关 save()。
    const lockedStore = new SettingsStore(path, fakeSafeStorage(false));
    lockedStore.save({ wowDirectory: "/wow" });
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.anthropicApiKey).toEqual(before.anthropicApiKey); // 逐字节原样保留
  });

  it("回归(复核 Critical):patch 命中的密钥字段仍正常加密新值,其余密钥字段原样保留", () => {
    const path = tmpPath();
    const store = new SettingsStore(path, fakeSafeStorage(true));
    store.save({ anthropicApiKey: "sk-1", deepseekApiKey: "ds-1" });
    const before = JSON.parse(readFileSync(path, "utf-8"));

    store.save({ anthropicApiKey: "sk-2" }); // 只改 anthropic
    const after = JSON.parse(readFileSync(path, "utf-8"));
    expect(after.anthropicApiKey).not.toEqual(before.anthropicApiKey);
    expect(store.get().anthropicApiKey).toBe("sk-2");
    // 未被这次 patch 触及的 deepseekApiKey 原样保留(同一份密文,不重新加密)。
    expect(after.deepseekApiKey).toEqual(before.deepseekApiKey);
    expect(store.get().deepseekApiKey).toBe("ds-1");
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
