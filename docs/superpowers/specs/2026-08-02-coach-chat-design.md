# Ask the Coach: In-Match AI Chat (coach chat) Design

Date: 2026-08-02 · Status: Pending user review
Participation in decisions: User final decisions are listed point-by-point in the "Decision Record" section.

## Goal

Provide the user with a chat box within the match report to freely ask follow-up questions to the AI coach surrounding the **current match/round**
("Why did you say I should have popped a defensive at 1:20?", "What was the enemy priest doing at the start?"). The AI responds with the full
match context and previously generated analysis conclusions, supporting continuous multi-turn conversations, memory, and the ability to resume chatting after closing and reopening.

## Core Mechanism: Chat = resume the CLI session from the analysis call

**Do not seed context separately.** The CLI call for "AI Analysis" itself (the full findings prompt +
the model's output conclusions) serves as the natural conversation context — chat directly resumes that session,
only sending new questions each round. This leads to two hard prerequisites (decided by the user):

1. **Only local CLI backends support chat** (claudeCli / agy / codex); Anthropic API and
   DeepSeek backends do not support it, and the chat card will display guiding copy.
2. **AI analysis for the current round must be completed first using the same CLI agent** before chatting can begin — cross-agent
   session reuse is impossible. When unmet, the entire chat card turns into a prompt state: "You must start an AI analysis before
   chatting" (including cases where old caches lack a session id, which is fixed by re-analyzing).

### Session Interfaces for the Three CLIs (confirmed by local testing on 2026-08-02)

| CLI       | Capturing/specifying session during analysis                                   | Resuming chat (only sending new questions)           |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| claudeCli | Add `--session-id <UUID we generate>` to analysis call (we define the id, no output parsing needed) | `claude -p --resume <id> <new question>`             |
| agy       | Change analysis call to `--output-format json`, extract `conversation_id` from return envelope (field confirmed to exist) | `agy --print <new question> --conversation <id> --sandbox` |
| codex     | Add `--json` to analysis call (JSONL event stream contains session id; final answer still goes to `-o` file) | `codex exec resume <id> <new question>`              |

Unified abstraction (encapsulated in `localAiBackends.ts`, reusing the existing Runner/timeout/subprocess tracking/
win32 spill mechanisms):

```ts
// Analysis side: Existing AnthropicLike.stream adds optional session capture
// Chat side:
continueChat(backend, sessionId, question, model): Promise<string>
```

## Analysis Pipeline Changes (Capturing Session ID)

- `run()` (`main/analysis.ts`) captures session ID when running analysis via CLI backends, writing to the slot for that analysis run (new optional field `sessionId` in analysis-v2 slot). API backends do not have this field.
- claudeCli: Generate a new UUID passed to `--session-id` for each analysis run. **bad-json retries (attempt 2) must use a new UUID** (seeding twice with the same ID collides with an existing session).
- agy: Analysis call switches to `--output-format json`, parses envelope `{conversation_id, status, response}`, and only `response` is passed to parseModelJsonArray; `status !== "SUCCESS"` is handled via existing error paths. If envelope parsing fails, fall back to plain text (legacy behavior), yielding no session ID and blocking the chat gate normally — the main analysis flow must never fail due to session capture failure.
- codex: Add `--json`, session ID parsed from JSONL event stream; answer still taken from `-o` file, stdout no longer used as fallback source (JSONL is not plain text). If ID cannot be parsed, same as above: analysis succeeds normally.
- deepen: Keep current independent single-shot invocation, does not enter session or capture.

## Chat Service and Persistence

- Main side adds chat service (analysis.ts pattern: service + ipc.ts handler + preload): `chat.send({matchId, question})`, `chat.get(matchId)`, `chat.cancel(matchId)`.
- Persistence `<matchDir>/coachChat.<lang>.json`:

```ts
{ version: 1,
  threads: { [cliBackend]: {
    sessionId: string,          // initial value = ID captured from analysis slot; updated after self-healing
    model: string,              // tracks analysis slot, continued chat reuses it
    messages: [{role: "user"|"assistant", content, at}],
  } } }
```

- **One thread per CLI**: Switching CLI = switching displayed thread (histories are isolated); when current CLI has no thread, the first message takes sessionId from that CLI's analysis slot to create a thread.
- Source of truth is always our persisted thread history; CLI session is merely a handle.
- Disk writing uses atomic tmp+rename replacement (existing cache convention); only one in-flight message allowed per match at a time (in-flight Set idempotency guard, precedent in windowAnalysis); does not interfere with batch analysis / manual analysis (different channels, does not write analysis cache).
- Language: Thread files are partitioned by current aiLanguage, threshold check also queries analysis cache for the current language (system prompt language in session matches analysis, naturally consistent).

## Self-Healing: Reseeding on Resume Failure

Session files are managed by individual CLIs and may expire or be cleared. Resuming on error triggers two-stage self-healing:
`chat.send` returns `need-reseed`, renderer only then uses `buildAnalysisInput` (same source as analysis) to reconstruct richContext (not built or passed during normal sends to save CPU), combined with existing findings summary + past conversations in this thread into a seed and calls `chat.send({…, seed})` again — main starts a new session (claudeCli new UUID / agy·codex captured from output), updates thread sessionId, and resends current question. Only if self-healing fails once is that message marked as failed. Messages are never lost.

## UI (Report Right Column, New "Ask Coach" Card Below AI Analysis Card)

State machine (4 mutually exclusive card states):

1. **Unsupported Backend** (current backend is not CLI): Guiding copy "Coach chat requires a local CLI backend" → directs to settings.
2. **Not Ready** (current CLI has no analysis cache for this round, or cache lacks sessionId): Prompt "Must run AI analysis before chatting" — unlocked when user runs "AI Analysis" from analysis card.
3. **Ready to Chat**: Message list (user right / coach left) + input box + send; header displays current CLI and model in small text (e.g. `claude · sonnet`). CLI outputs return in full (non-streaming), displaying "Coach is thinking..." + stop button while in flight.
4. **Single Message Failed**: Marked "Send failed · Retry", retry resends the same question (attempting self-healing first).

v1 plain text rendering (spell names remain English); no timestamp jump chips, no cross-match chat (Phase 2); solo shuffle chats are independent per round.

## Error Handling

- Stop button: Kills that CLI invocation (targeted activeChildren version), partial answers are not saved.
- Timeout reuses CLI backend 300s upper limit.
- Chat responses are free-form text, not routed through findings audit gate — fixed footer line in small text: "Responses are inferred from logs and may contain errors" (ethics & honesty).

## Testing

- Main service unit tests (stub Runner): 3 CLI seeding/resume parameters correct, agy json envelope parsing (including status != SUCCESS / envelope parse failure fallback), codex JSONL id extraction, resume failure self-healing with new session, threads isolated by CLI, gate evaluation (no analysis / no sessionId / API backend), disk persistence shape and concurrency guards, claudeCli retry UUID rotation.
- Renderer component tests (stub bridge): 4-state visibility, send / in-flight / failed retry, backend switching and thread switching.
- **Real-machine smoke (prerequisite for sign-off)**: claude CLI real analysis on one match → real resume chat for one round; same for agy (session behavior cannot be simulated with stubs, lessons from placeholder discipline).
- Full repo gate `npm run presubmit`; if chat card affects report layout, follow visual baseline recipe.

## Non-Goals (YAGNI, Explicitly Out of Scope)

- API backend chat (including any "API full history replay" form) — ruled out by user decision.
- Cross-match / global chat, timestamp jump chips, structured audit of chat answers, advanced session features beyond codex resume, chat content entering error notebook / aggregations.

## Decision Record

- Chat target = AI coach answering follow-ups on the match (not role-play / human social chat).
- One per match, entry point in match report; conversations persisted for resumption.
- Local CLI support only; stateful sessions, no stateless full-history re-transmission.
- All three CLIs treated equally (agy/codex native session confirmed via local testing).
- Chat prerequisite = same CLI agent has completed AI analysis for this round (reuses analysis session).

## Risks and Open Points

- agy/codex analysis output format switching (json/JSONL) touches the **existing main analysis pipeline**, representing the highest risk step in this design — implementation plan must cover unit tests first + smoke test each on real machine once.
- Disk usage / expiration policies of CLI sessions are not managed by us (belong to respective CLIs); covered by self-healing fallback path.
- Resume chat passes `--model` matching the thread record by default (same source as seeding); if testing reveals a CLI rejects this parameter on resume, remove it — direction fixed, leaving only compatibility switch.
