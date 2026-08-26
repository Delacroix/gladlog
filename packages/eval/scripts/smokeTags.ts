/**
 * Real-model smoke for the new prompt facts ([MANA] / [IMMUNE] / [EMPOWER] /
 * [CC BROKEN]): feed a saved real prompt to a responder and print the reply,
 * so a human can read whether the model actually consumes the tags — the
 * placeholder-discipline lesson: unit tests cannot see a model misreading a
 * fact, only a real completion can.
 *
 * Backend: local CLI via `cliDriver` (agy by default — 8× faster than
 * `claude -p` on big prompts, runs in a NEUTRAL cwd so the repo's CLAUDE.md
 * cannot contaminate the completion; see cliDriver's header). DeepSeek was
 * dropped per the user's 2026-08-25 directive after the sim key ran dry
 * mid-batch (89% Insufficient Balance on the 2026-08-23 ablation run).
 *
 * Usage: npx tsx packages/eval/scripts/smokeTags.ts <promptFile> [...more]
 *   BACKEND=claude to cross-check on the slower backend.
 */
import { readFileSync } from "node:fs";

import { callCli, type CliBackend } from "../src/explore/cliDriver";
import { RESPONDER_SYSTEM_PROMPT } from "../src/family/deepseekDriver";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: smokeTags.ts <promptFile> [...more]");
  process.exit(1);
}
const backend = (process.env.BACKEND ?? "agy") as CliBackend;
// Optional model override (e.g. MODEL=gpt-... for agy's GPT quota pool when
// the default model's quota is exhausted — per-model quotas, user 2026-08-25).
const model = process.env.MODEL || undefined;

const TAGS = ["[MANA]", "[IMMUNE", "[EMPOWER", "[CC BROKEN]"];

for (const f of files) {
  const prompt = readFileSync(f, "utf8");
  const present = TAGS.filter((t) => prompt.includes(t));
  console.log(`\n══════ ${f}`);
  console.log(
    `backend: ${backend}  tags present in prompt: ${present.join(" ") || "(none)"}`,
  );
  const out = await callCli(
    backend,
    `${RESPONDER_SYSTEM_PROMPT}\n\n${prompt}`,
    { timeoutMs: 300_000, model },
  );
  console.log("── response:\n");
  console.log(out);
  console.log("\n── tag echoes in response:");
  for (const t of TAGS) {
    const mentioned =
      out.includes(t) ||
      (t === "[MANA]" && /mana/i.test(out)) ||
      (t === "[IMMUNE" && /immun/i.test(out)) ||
      (t === "[EMPOWER" && /empower|充能/i.test(out)) ||
      (t === "[CC BROKEN]" && /broke|broken|break/i.test(out));
    console.log(
      `  ${t}: prompt=${present.includes(t)} responseMentions=${mentioned}`,
    );
  }
}
