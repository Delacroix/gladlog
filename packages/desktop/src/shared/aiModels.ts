/**
 * **Single source of truth** for AI backends and their selectable models
 * (shared across processes).
 *
 * All three consumers must import from here instead of hardcoding their own:
 *   - main/settingsStore.ts —— validates the model id in a patch
 *   - main/analysis.ts, main/compare.ts —— resolve the current backend's model
 *   - renderer/components/SettingsPanel.tsx —— renders the dropdown options
 *
 * Living in shared/ is a build constraint, not fastidiousness: a value import
 * from renderer into main/* drags fs/path into the renderer bundle (the v0.0.4
 * packaging incident), and it only blows up under electron-vite build.
 */

export type AiBackend =
  "anthropic" | "claudeCli" | "agy" | "codex" | "deepseek";
export const AI_BACKENDS: AiBackend[] = [
  "anthropic",
  "claudeCli",
  "agy",
  "codex",
  "deepseek",
];

export interface AiModelOption {
  /** The actual value handed to the backend: the Anthropic API `model`, or the
   * CLI's --model argument. */
  id: string;
  label: string;
  /**
   * The full name `--model` requires when invoking agy directly (matching the
   * `agy models` listing verbatim). label is display-only and may be changed
   * freely; cliName is a protocol value — changing it changes the model.
   */
  cliName?: string;
}

/**
 * Selectable models per backend.
 * anthropic/claudeCli use official Anthropic model ids; agy uses agy-run.mjs's
 * `--model <alias>` aliases (see MODEL_ALIASES in
 * ~/.claude/skills/agy/scripts/agy-run.mjs); codex uses the model id of
 * `codex exec -m <id>` (the user's default model in ~/.codex/config.toml).
 * The three namespaces are not interchangeable, hence one table per backend.
 */
export const AI_MODELS: Record<AiBackend, AiModelOption[]> = {
  anthropic: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  claudeCli: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  agy: [
    {
      id: "pro",
      label: "Gemini 3.1 Pro (High)",
      cliName: "Gemini 3.1 Pro (High)",
    },
    {
      id: "pro-low",
      label: "Gemini 3.1 Pro (Low)",
      cliName: "Gemini 3.1 Pro (Low)",
    },
    {
      id: "flash-high",
      label: "Gemini 3.5 Flash (High)",
      cliName: "Gemini 3.5 Flash (High)",
    },
    {
      id: "flash",
      label: "Gemini 3.5 Flash (Medium)",
      cliName: "Gemini 3.5 Flash (Medium)",
    },
    {
      id: "flash-low",
      label: "Gemini 3.5 Flash (Low)",
      cliName: "Gemini 3.5 Flash (Low)",
    },
    {
      id: "gpt-oss",
      label: "GPT-OSS 120B (Medium)",
      cliName: "GPT-OSS 120B (Medium)",
    },
    {
      id: "claude-opus",
      label: "Claude Opus 4.6 (Thinking)",
      cliName: "Claude Opus 4.6 (Thinking)",
    },
    {
      id: "claude-sonnet",
      label: "Claude Sonnet 4.6 (Thinking)",
      cliName: "Claude Sonnet 4.6 (Thinking)",
    },
  ],
  codex: [{ id: "gpt-5.5", label: "GPT-5.5" }],
  // DeepSeek's official API (OpenAI-compatible; not local — data leaves the
  // machine). id = the API model name.
  deepseek: [
    { id: "deepseek-chat", label: "DeepSeek V3(chat,快)" },
    { id: "deepseek-reasoner", label: "DeepSeek R1(reasoner,慢)" },
  ],
};

/** Per-backend default when no model has been explicitly selected. */
export const AI_DEFAULT_MODEL: Record<AiBackend, string> = {
  anthropic: "claude-sonnet-5",
  claudeCli: "claude-sonnet-5",
  agy: "pro",
  codex: "gpt-5.5",
  deepseek: "deepseek-chat",
};

/**
 * Local backend → executable name. Shared by main's auto-detection
 * (cliDetect.ts) and the renderer's "xx not detected" hint copy — kept in
 * shared to avoid a value import from renderer into main.
 */
export const BACKEND_CLI_TOOL: Partial<
  Record<AiBackend, "claude" | "agy" | "codex">
> = {
  claudeCli: "claude",
  agy: "agy",
  codex: "codex",
};

/**
 * The `--model` argument for direct agy invocation: alias id → full CLI name.
 * Existing settings store the alias id (pro/flash/…) and are not migrated;
 * unknown ids pass through unchanged, so hand-edited configs that write the
 * full name directly keep working.
 */
export function agyCliModelName(id: string): string {
  return AI_MODELS.agy.find((m) => m.id === id)?.cliName ?? id;
}

/** Model selection remembered per backend; switching backends does not clobber
 * the others. */
export type AiModelSelection = Partial<Record<AiBackend, string>>;

/**
 * Single-source predicate (final review F3): "is this backend a local CLI (with
 * a resumable session)" used to be hardcoded as the same claudeCli/agy/codex
 * list in three places — analysis.ts (inline isCliBackend), coachChat.ts
 * (CLI_BACKENDS) and localAiBackends.ts (the CliChatBackend literal union).
 * Coach chat resumes the CLI session captured during the analysis phase, so
 * both sides must judge by the same constant, not by three literals that
 * "happen to look alike". All three now import from here;
 * localAiBackends.ts's `CliChatBackend` is now an alias of this type (the
 * public name is unchanged, so consumers' imports need no edits).
 */
export const CLI_AI_BACKENDS = ["claudeCli", "agy", "codex"] as const;
export type CliAiBackend = (typeof CLI_AI_BACKENDS)[number];

/** Type-narrowing predicate: whether `backend` is in CLI_AI_BACKENDS. */
export function isCliAiBackend(backend: string): backend is CliAiBackend {
  return (CLI_AI_BACKENDS as readonly string[]).includes(backend);
}

export function isKnownModel(backend: AiBackend, id: string): boolean {
  return AI_MODELS[backend].some((m) => m.id === id);
}

/**
 * The model currently in effect. All three call paths — analysis, comparison
 * and local CLI — go through here; do not write scattered defaults like
 * `settings.anthropicModel ?? "claude-sonnet-5"` again.
 * If an unknown id is stored (hand-edited config file, downgrade fallback), we
 * fall back to that backend's default.
 */
export function resolveAiModel(settings: {
  aiBackend?: AiBackend | null;
  aiModels?: AiModelSelection | null;
}): string {
  const backend = settings.aiBackend ?? "anthropic";
  const picked = settings.aiModels?.[backend];
  return picked && isKnownModel(backend, picked)
    ? picked
    : AI_DEFAULT_MODEL[backend];
}
