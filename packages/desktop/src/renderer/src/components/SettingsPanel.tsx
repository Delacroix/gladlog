import { useEffect, useState } from "react";

import type { AiLanguage, GladlogSettings } from "../../../main/settingsStore";
import {
  AI_MODELS,
  BACKEND_CLI_TOOL,
  resolveAiModel,
  type AiBackend,
} from "../../../shared/aiModels";
import { API_KEY_REDACTED } from "../../../shared/protocol";
import { bridge } from "../bridge";
import { ImportButton } from "./ImportButton";

type SettingsGroup = "game" | "ai";

/**
 * 设置页(1i 重设计):分组卡内三列 grid(标签 | 值/输入 | 操作),
 * 保存反馈就地显示在分组标题行(2s 消失),API key 前置「已设置」胶囊。
 */
export function SettingsPanel() {
  const [settings, setSettings] = useState<GladlogSettings | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [cmdInput, setCmdInput] = useState("");
  const [saved, setSaved] = useState<{
    group: SettingsGroup;
    note: string;
  } | null>(null);

  useEffect(() => {
    void bridge()
      .settings.get()
      .then((s) => {
        setSettings(s);
        setCmdInput(s.aiBackendCommand ?? "");
      });
  }, []);

  // 命令路径留空时自动检测本地 CLI,就地显示结果 —— 不用等到跑分析才
  // 发现没装。桩经常缺 ai 面(组件测试/旧 fixture),必须 optional+catch。
  const backend = settings?.aiBackend;
  const cmdSaved = settings?.aiBackendCommand;
  const [detected, setDetected] = useState<{
    backend: AiBackend;
    path: string | null;
  } | null>(null);
  useEffect(() => {
    setDetected(null);
    if (!backend || !BACKEND_CLI_TOOL[backend] || cmdSaved) return;
    let stale = false;
    try {
      void bridge()
        .ai?.detectCli?.(backend)
        ?.then((r) => {
          if (!stale) setDetected({ backend, path: r?.path ?? null });
        })
        ?.catch(() => undefined);
    } catch {
      // 桩缺 ai 面:不渲染检测状态行
    }
    return () => {
      stale = true;
    };
  }, [backend, cmdSaved]);

  if (!settings) return <div className="settings">加载中…</div>;

  const save = async (
    partial: Partial<GladlogSettings>,
    note: string,
    group: SettingsGroup = "ai",
  ) => {
    const next = await bridge().settings.save(partial);
    setSettings(next);
    setSaved({ group, note });
    setTimeout(() => setSaved(null), 2000);
  };

  const keySet =
    settings.anthropicApiKey === API_KEY_REDACTED ||
    (!!settings.anthropicApiKey && settings.anthropicApiKey.length > 0);

  const groupHead = (label: string, group: SettingsGroup) => (
    <span className="settings-group-head">
      <span className="rpt-card-label">{label}</span>
      {saved?.group === group && (
        <span className="settings-saved-inline">✓ {saved.note}</span>
      )}
    </span>
  );

  return (
    <div className="settings" data-testid="settings-panel">
      <h2>设置</h2>

      <section className="dash-card">
        {groupHead("游戏", "game")}
        <div className="settings-grid">
          <span className="settings-k">WoW 目录</span>
          <span className="settings-v" title={settings.wowDirectory ?? ""}>
            {settings.wowDirectory ?? "未设置 —— 选择后自动开始监控战斗日志"}
          </span>
          <button
            onClick={() =>
              void bridge()
                .app.selectDirectory()
                .then((dir) => {
                  if (dir)
                    setSettings((s) => (s ? { ...s, wowDirectory: dir } : s));
                })
            }
          >
            选择目录…
          </button>

          <span className="settings-k">历史日志</span>
          <span className="settings-v">重复导入按场次自动去重</span>
          <ImportButton />
        </div>
      </section>

      <section className="dash-card">
        {groupHead("AI 分析", "ai")}
        <div className="settings-grid">
          <span className="settings-k">Anthropic API key</span>
          <span className="settings-key-cell">
            {keySet ? (
              <span className="settings-pill-ok">已设置</span>
            ) : (
              <span className="settings-v">
                未设置(没有 key 时分析走确定性回退)
              </span>
            )}
            <input
              type="password"
              placeholder={keySet ? "输入以更换" : "sk-ant-…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
          </span>
          <span className="settings-actions">
            <button
              disabled={!keyInput.trim()}
              onClick={() => {
                void save(
                  { anthropicApiKey: keyInput.trim() },
                  "API key 已保存",
                );
                setKeyInput("");
              }}
            >
              保存
            </button>
            {keySet && (
              <button
                className="settings-danger"
                onClick={() =>
                  void save({ anthropicApiKey: null }, "已清除 key")
                }
              >
                清除
              </button>
            )}
          </span>

          <span className="settings-k">后端</span>
          <span>
            <select
              aria-label="AI 后端"
              value={settings.aiBackend}
              onChange={(e) =>
                void save(
                  { aiBackend: e.target.value as AiBackend },
                  "后端已切换",
                )
              }
            >
              <option value="anthropic">Anthropic API</option>
              <option value="claudeCli">Claude CLI(本地)</option>
              <option value="agy">agy / Gemini(本地)</option>
              <option value="codex">Codex(本地)</option>
            </select>
            <span className="settings-note">
              调试可切 Claude CLI / agy / Codex(本地),不走网络
            </span>
          </span>
          <span />

          <span className="settings-k">模型</span>
          <select
            aria-label="模型"
            value={resolveAiModel(settings)}
            onChange={(e) =>
              void save(
                {
                  // 按后端分格写:切回上一个后端时它自己的选择还在
                  aiModels: {
                    ...settings.aiModels,
                    [settings.aiBackend]: e.target.value,
                  },
                },
                "模型已保存",
              )
            }
          >
            {AI_MODELS[settings.aiBackend].map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span />

          {settings.aiBackend !== "anthropic" && (
            <>
              <span className="settings-k">命令路径</span>
              <span>
                <input
                  placeholder={
                    settings.aiBackend === "agy"
                      ? "留空自动检测;或填 agy 可执行文件完整路径(.mjs 走旧包装脚本)"
                      : `留空自动检测;或填 ${BACKEND_CLI_TOOL[settings.aiBackend]} 可执行文件完整路径`
                  }
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  onBlur={() =>
                    void save(
                      { aiBackendCommand: cmdInput.trim() || null },
                      "命令路径已保存",
                    )
                  }
                />
                {!cmdInput.trim() &&
                  detected?.backend === settings.aiBackend && (
                    <span className="settings-note">
                      {detected.path
                        ? `已检测到:${detected.path}`
                        : `未检测到 ${BACKEND_CLI_TOOL[settings.aiBackend]},请安装后重开设置页,或填写完整路径`}
                    </span>
                  )}
              </span>
              <span />
            </>
          )}

          <span className="settings-k">教练回复语言</span>
          <div className="rpt-mode-seg settings-seg">
            {(["zh", "en"] as AiLanguage[]).map((l) => (
              <button
                key={l}
                className={settings.aiLanguage === l ? "active" : ""}
                onClick={() => void save({ aiLanguage: l }, "语言已切换")}
              >
                {l === "zh" ? "中文" : "EN"}
              </button>
            ))}
          </div>
          <span />
        </div>
      </section>
    </div>
  );
}
