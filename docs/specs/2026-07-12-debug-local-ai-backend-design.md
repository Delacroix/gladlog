# Local AI Backend for Debugging (claude / agy CLI) Design

Date: 2026-07-12
Status: Pending User Review

## Background and Goals

When the packaged App lacks an Anthropic API key, both SP-A findings and SP-B2 cohort narratives degrade to deterministic fallbacks (screenshot: `0 findings` / `Reason: NO_API_KEY`, cohort only shows measured numbers). The user wants a **debug mode**: route the LLM calls in these two places to a **local CLI** (`claude` print mode or `agy` Gemini), so real AI outputs can be seen without configuring/paying for an API key. For dev/debugging use, only available on machines with claude/agy installed; not an end-user feature.

User confirmed: support **both options**; **persist dropdown setting**.

## Existing Seams

Both services get an `AnthropicLike` through `clientFactory`:

```ts
interface AnthropicLike {
  stream(params: {
    model;
    max_tokens;
    messages;
  }): AsyncIterable<{ delta?: string }>;
}
```

`realClientFactory(key)` is the Anthropic implementation. The service's gate is `if (!settings.anthropicApiKey) return fallback()`. The local backend just needs to implement another `AnthropicLike` and change the gate: local backend requires no key. Downstream honesty gates (`auditFindings`/`claimChecker`) remain unchanged, local backend output goes through the same validation.

## Component 1: Local Backend (`packages/desktop/src/main/localAiBackends.ts`)

Two factories, each returning an `AnthropicLike`:

- `claudeCliClientFactory(cmd: string)` — use `execFile` (**non-shell**) to spawn `cmd -p --output-format text`, prompt is written via **stdin** (avoiding arg length limits); stdout chunks are yielded segment by segment `yield { delta }`. stdout is already clean completion.
- `agyClientFactory(scriptPath: string)` — spawn `node <scriptPath> ask <prompt>`; `<prompt>` as an **args array element** (no shell interpolation → no injection); stdout yielded segment by segment, **discarding the starting `[agy-run] ...` header line** (the `[agy-run]` line before the first newline).

**PATH Resolution (critical for packaged GUI)**: macOS GUI processes do not inherit the login shell PATH. On startup, resolve the executable path once using the login shell: `$SHELL -lc 'command -v claude'` (agy path is fixed `~/.claude/skills/agy/scripts/agy-run.mjs`, node is resolved similarly); cache the resolution result. `aiBackendCommand` in settings overrides this (if user provides absolute path, use it directly, skip resolution). **Injection Protection**: strictly use `execFile`/`spawn` + args array, never `shell: true` concatenating prompts containing match data.

**Streaming**: stdout `data` event yields a delta (progressive display); process exits normally (code 0) → iteration ends; non-zero exit / spawn error / timeout (120s) → throws error.

## Component 2: Settings (`settingsStore.ts`)

Add to `GladlogSettings`:

- `aiBackend: "anthropic" | "claudeCli" | "agy"` (default `"anthropic"`)
- `aiBackendCommand: string | null` (default null; overrides claude executable / agy script path)

Add these two keys to `sanitizeSettingsPatch` whitelist; `aiBackend` validates enum, invalid values fallback to `"anthropic"`. `aiBackendCommand` is a path not a key, no redaction.

## Component 3: Service Wiring (`analysis.ts` + `compare.ts`)

Extract a shared `resolveAiClient(settings, deps): AnthropicLike | null` (put in `ai.ts`):

- `aiBackend === "anthropic"`: has key → `realClientFactory(key)`; no key → `null` (fallback, current state).
- `aiBackend === "claudeCli"`: `claudeCliClientFactory(resolvedClaudeCmd)` (no key needed).
- `aiBackend === "agy"`: `agyClientFactory(resolvedAgyPath)` (no key needed).

Services replace the existing `if (!anthropicApiKey) fallback` with `const client = resolveAiClient(settings, deps); if (!client) return fallback();`. Injected `deps.clientFactory` takes precedence for testing (keeps existing tests).

## Component 4: Settings UI (`DevPanel.tsx`, Developer View)

Add an "AI Backend" dropdown in developer view: `Anthropic API` / `Claude CLI` / `agy (Gemini)`, value = `aiBackend`; `onChange` → `bridge().settings.save({ aiBackend })`, on mount `settings.get()` backfills current value. Optional text box for `aiBackendCommand` (leave empty = auto resolution). Debug features are kept in developer view, not polluting the main interface.

## Data Flow

Click "Re-analyze / Re-compare" in panel → service `run()` → `resolveAiClient` selects client by `aiBackend` → local backend spawns CLI, prompt to stdin, stdout streams delta → service aggregates → honesty gate validation → findings/narrative or dropped.

## Error Handling

- CLI not found / non-zero exit / timeout → service emits `error` (panel shows "Backend failed: <msg>"), **no silent deterministic fallback** (let user know if debug backend ran or not).
- Local model output invalid format (JSON findings / `{{placeholder}}` template) → honesty gate drops as usual → panel shows dropped count (informational: model didn't follow format, rather than silently empty).
- stdout parsing: JSON.parse failure (analysis) → existing invalid-JSON fallback path.

## Testing Strategy (vitest)

- `claudeCliClientFactory` / `agyClientFactory`: inject fake spawn (stub child, controlled stdout/exit) → assert stdout → deltas, agy header line stripping, prompt written via stdin, non-zero exit rejects, timeout rejects.
- `resolveAiClient`: three backend selections + anthropic without key → null.
- Services: `aiBackend="claudeCli"` without key also uses client (no fallback) —— verified with stub client.
- Existing desktop suite does not regress (injected clientFactory priority preserved).

## Out of Scope

- End-user availability (only for dev machines with claude/agy installed).
- True streaming tokens (CLI buffering yielding whole blocks is acceptable).
- Granular model selection for backends (claude uses model configured by Claude Code; agy uses its default Gemini).
- Packaged distribution of claude/agy (not bundled).

## Unresolved Items

None (backend set + toggle UX confirmed).
