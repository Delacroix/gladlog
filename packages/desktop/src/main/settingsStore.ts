import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

import {
  AI_BACKENDS,
  isKnownModel,
  type AiBackend,
  type AiModelSelection,
} from "../shared/aiModels";

export type { AiBackend, AiModelSelection };
export type AiLanguage = "zh" | "en";
const AI_LANGUAGES: AiLanguage[] = ["zh", "en"];

export interface GladlogSettings {
  wowDirectory: string | null;
  anthropicApiKey: string | null;
  /** DeepSeek 官方 API(aiBackend="deepseek")的 key;掩码/哨兵同 anthropic。 */
  deepseekApiKey: string | null;
  /** 按后端分别记忆的模型;取当前生效值一律用 resolveAiModel。 */
  aiModels: AiModelSelection;
  // Debug: route LLM calls to a local CLI instead of the Anthropic API.
  aiBackend: AiBackend;
  aiBackendCommand: string | null;
  /** 教练回复输出语言(backlog #1);默认中文,与 UI 一致。 */
  aiLanguage: AiLanguage;
  // ── OBS 外控录像(2026-07-28 路线C一期)──
  recordingEnabled: boolean;
  /** null → 连接/占位用 DEFAULT_OBS_WS_URL。 */
  obsWebsocketUrl: string | null;
  obsWebsocketPassword: string | null;
  /** 保留最近 N 场录像(超出连视频文件一起删),0 = 不清理。 */
  recordingKeepCount: number;
}
const DEFAULTS: GladlogSettings = {
  wowDirectory: null,
  anthropicApiKey: null,
  deepseekApiKey: null,
  aiModels: {},
  aiBackend: "anthropic",
  aiBackendCommand: null,
  aiLanguage: "zh",
  recordingEnabled: false,
  obsWebsocketUrl: null,
  obsWebsocketPassword: null,
  recordingKeepCount: 50,
};

/** v0.0.15 及以前存的是单字段 anthropicModel;读盘时迁进 aiModels.anthropic。 */
interface LegacySettings {
  anthropicModel?: string | null;
}
function migrateLegacyModel(raw: Partial<GladlogSettings> & LegacySettings): {
  aiModels?: AiModelSelection;
} {
  const legacy = raw.anthropicModel;
  if (!legacy || raw.aiModels?.anthropic) return {};
  // 老字段是自由文本,可能是任意串 —— 只有落在白名单里才迁,否则丢弃走默认。
  return isKnownModel("anthropic", legacy)
    ? { aiModels: { ...raw.aiModels, anthropic: legacy } }
    : {};
}

// key 只存在于主进程;IPC 边界一律用哨兵替换真值(renderer 只需真值性)。
export {
  API_KEY_REDACTED,
  DEEPSEEK_KEY_REDACTED,
  OBS_PASSWORD_REDACTED,
} from "../shared/protocol";
import {
  API_KEY_REDACTED,
  DEEPSEEK_KEY_REDACTED,
  OBS_PASSWORD_REDACTED,
} from "../shared/protocol";

export function redactSettings(s: GladlogSettings): GladlogSettings {
  return {
    ...s,
    anthropicApiKey: s.anthropicApiKey ? API_KEY_REDACTED : null,
    deepseekApiKey: s.deepseekApiKey ? DEEPSEEK_KEY_REDACTED : null,
    obsWebsocketPassword: s.obsWebsocketPassword ? OBS_PASSWORD_REDACTED : null,
  };
}

export function sanitizeSettingsPatch(
  partial: Partial<GladlogSettings>,
): Partial<GladlogSettings> {
  let out = partial;
  if (out.anthropicApiKey === API_KEY_REDACTED) {
    const { anthropicApiKey: _redacted, ...rest } = out;
    out = rest;
  }
  if (out.obsWebsocketPassword === OBS_PASSWORD_REDACTED) {
    const { obsWebsocketPassword: _redacted, ...rest } = out;
    out = rest;
  }
  if (out.deepseekApiKey === DEEPSEEK_KEY_REDACTED) {
    const { deepseekApiKey: _redacted, ...rest } = out;
    out = rest;
  }
  if (
    out.recordingKeepCount !== undefined &&
    (!Number.isFinite(out.recordingKeepCount) || out.recordingKeepCount < 0)
  ) {
    const { recordingKeepCount: _bad, ...rest } = out;
    out = rest;
  }
  // Reject an unknown aiBackend value rather than persisting garbage.
  if (out.aiBackend !== undefined && !AI_BACKENDS.includes(out.aiBackend)) {
    const { aiBackend: _bad, ...rest } = out;
    out = rest;
  }
  if (out.aiLanguage !== undefined && !AI_LANGUAGES.includes(out.aiLanguage)) {
    const { aiLanguage: _bad, ...rest } = out;
    out = rest;
  }
  // 模型:逐格按后端白名单校验,丢掉未知 id 而不是整块拒绝 —— 下拉只可能
  // 产出合法值,能走到这里的非法值来自手改配置或旧版残留。
  if (out.aiModels !== undefined) {
    const clean: AiModelSelection = {};
    for (const backend of AI_BACKENDS) {
      const id = out.aiModels?.[backend];
      if (id && isKnownModel(backend, id)) clean[backend] = id;
    }
    out = { ...out, aiModels: clean };
  }
  return out;
}

// ── #21 item7:密钥落盘加密(Electron safeStorage,OS 钥匙串)──
//
// settingsStore.ts 本身保持 electron-free(便于纯 node 单测),真正的
// safeStorage 由调用方(main/index.ts)注入,测试用 fake 替身。
//
// 落盘形状:三个密钥字段(anthropicApiKey / deepseekApiKey /
// obsWebsocketPassword)加密后存成 `{ __enc: "<base64>" }`——合法明文密码
// 在 GladlogSettings 类型里必然是 string,永远不会长成"只有 __enc 一个
// key 的 object",所以这个 tag 形状不会与真实明文值碰撞。旧版(未升级前)
// 写的明文 string 读入原样接受、下次 save() 时才会被加密覆盖(渐进迁移,
// 不强制一次性迁移、不因迁移丢数据)。反向(新版写的 `{__enc}` 形状被旧版
// 读到)超出范围:旧版会把它当成一个不认识的字符串以外的值,读出来非
// string,越界行为不保证——见 BACKLOG #21 item7。
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(buffer: Buffer): string;
}

/** safeStorage 不可用(如部分 Linux 无 keyring)时的降级替身:全部当作不可用处理。 */
const NOOP_SAFE_STORAGE: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("safeStorage unavailable");
  },
  decryptString: () => {
    throw new Error("safeStorage unavailable");
  },
};

const SECRET_FIELDS = [
  "anthropicApiKey",
  "deepseekApiKey",
  "obsWebsocketPassword",
] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

interface EncryptedValue {
  __enc: string;
}
/** 形状判据:唯一 key 是 `__enc` 且值是 string。真实密码是裸 string,永远不会满足这个形状。 */
function isEncryptedValue(v: unknown): v is EncryptedValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 1 &&
    typeof (v as Record<string, unknown>).__enc === "string"
  );
}

export interface SettingsStoreWarning {
  kind: "encryption-unavailable" | "decrypt-failed" | "encrypt-failed";
  field?: SecretField;
  detail?: string;
}

export class SettingsStore {
  private warnedUnavailable = false;
  constructor(
    private filePath: string,
    private safeStorage: SafeStorageLike = NOOP_SAFE_STORAGE,
    private onWarn?: (warning: SettingsStoreWarning) => void,
  ) {}

  private warnEncryptionUnavailableOnce(): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    this.onWarn?.({
      kind: "encryption-unavailable",
      detail:
        "safeStorage.isEncryptionAvailable() === false,密钥/密码将以明文存储",
    });
  }

  /** 读盘侧:string(旧版明文)原样返回;`{__enc}` 形状尝试解密,失败/不可用一律降级空串 + warn,绝不抛出。 */
  private decryptSecret(raw: unknown, field: SecretField): string | null {
    if (raw == null) return null;
    if (typeof raw === "string") return raw;
    if (!isEncryptedValue(raw)) return null; // 未知形状,当缺失处理
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.onWarn?.({
        kind: "decrypt-failed",
        field,
        detail: "已加密存储但当前环境 safeStorage 不可用,无法解密",
      });
      return "";
    }
    try {
      return this.safeStorage.decryptString(Buffer.from(raw.__enc, "base64"));
    } catch (err) {
      this.onWarn?.({
        kind: "decrypt-failed",
        field,
        detail: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }

  /** 写盘侧:可用则加密成 `{__enc}`;不可用/加密抛错一律降级明文 + warn,绝不抛出。 */
  private encryptSecret(
    value: string | null,
    field: SecretField,
  ): string | null | EncryptedValue {
    if (value == null || value === "") return value ?? null;
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.warnEncryptionUnavailableOnce();
      return value;
    }
    try {
      return {
        __enc: this.safeStorage.encryptString(value).toString("base64"),
      };
    } catch (err) {
      this.onWarn?.({
        kind: "encrypt-failed",
        field,
        detail: err instanceof Error ? err.message : String(err),
      });
      return value;
    }
  }

  get(): GladlogSettings {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<
        Record<keyof GladlogSettings, unknown>
      > &
        LegacySettings;
      const merged = {
        ...DEFAULTS,
        ...(raw as Partial<GladlogSettings>),
        ...migrateLegacyModel(raw as Partial<GladlogSettings> & LegacySettings),
      } as GladlogSettings;
      for (const field of SECRET_FIELDS) {
        merged[field] = this.decryptSecret(raw[field], field);
      }
      return merged;
    } catch {
      return { ...DEFAULTS };
    }
  }
  save(partial: Partial<GladlogSettings>): GladlogSettings {
    const next = { ...this.get(), ...partial };
    const onDisk: Record<string, unknown> = { ...next };
    for (const field of SECRET_FIELDS) {
      onDisk[field] = this.encryptSecret(next[field], field);
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(onDisk, null, 2));
    renameSync(tmp, this.filePath);
    return next;
  }
}
