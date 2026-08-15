/**
 * One-shot reference-judge pass for Task 8's constraint-budget audit
 * (2026-08-15). NOT part of the reusable A/B harness (constraintBudgetAudit.ts
 * stays scoped to select/run/report) — this is a single bounded add-on run to
 * satisfy the plan's "judge reference with caveat" deliverable component.
 *
 * Per CLAUDE.md's judge-noise-floor note (accuracy SD≈1.3, |Δ|<0.4
 * undetectable) a formal 7-dim rubric judge cannot move this decision at
 * n=20 — the deterministic proxy (auditFindings' grounding/numeric/causal/
 * hindsight gates, metric ① in the report) is the reliable signal here. This
 * script exists ONLY to produce a directional reference number, explicitly
 * caveated as non-decisive in the report.
 *
 * Rubric: single dimension, "specificity" 1-5 — does the finding read as a
 * concrete, actionable coaching note grounded in this match's actual events,
 * or generic filler that could apply to any match ("play more carefully").
 * Truthfulness/grounding is already guaranteed by the audit gate (layers
 * 1-5in auditFindings.ts) that already ran on every finding scored here —
 * this judge pass is not re-checking that, only adding the softer
 * "specific vs filler" read a human reviewer would apply next.
 *
 * Usage: tsx constraintBudgetAuditJudge.ts [--n=20] [--seed=<s>]
 * Reads `$EVAL_HOME/constraint-budget-audit/new-findings.json` (written by
 * constraintBudgetAudit.ts report), judges a seeded sample of the
 * relaxation-attributable ones (tags include C1/C2/C3, excludes
 * unattributed/ambiguous — those are noise, not what a relaxation-value
 * judgment is about), writes `judge-sample.json` alongside it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { seededShuffle } from "../../eval/src/explore/buildSession";
import { claudeCliClientFactory } from "../src/main/localAiBackends";
import { AI_DEFAULT_MODEL } from "../src/shared/aiModels";

const EVAL_HOME =
  process.env.GLADLOG_EVAL_HOME ||
  join(homedir(), "code", "gladlog-eval-private");
const HOME = join(EVAL_HOME, "constraint-budget-audit");

interface NewFindingRow {
  matchId: string;
  key: string;
  category: string;
  severity: string;
  tags: string[];
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function callOnce(
  client: ReturnType<typeof claudeCliClientFactory>,
  model: string,
  system: string,
  prompt: string,
): Promise<string> {
  let raw = "";
  for await (const ev of client.stream({
    model,
    max_tokens: 512,
    system,
    messages: [{ role: "user", content: prompt }],
  })) {
    if (ev.delta) raw += ev.delta;
  }
  return raw;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const n = args.n ? Number(args.n) : 20;
  const seed = args.seed ?? "constraint-budget-audit-judge-2026-08-15";

  const all = JSON.parse(
    readFileSync(join(HOME, "new-findings.json"), "utf8"),
  ) as NewFindingRow[];
  const attributable = all.filter((f) =>
    f.tags.some(
      (t) => t.startsWith("C1") || t.startsWith("C2") || t.startsWith("C3"),
    ),
  );
  const sample = seededShuffle(attributable, seed).slice(0, n);
  console.log(
    `[judge] attributable pool=${attributable.length} sampling n=${sample.length} seed=${seed}`,
  );

  const client = claudeCliClientFactory({ cmd: "claude" });
  const model = AI_DEFAULT_MODEL.claudeCli;
  const system =
    'You are a strict reviewer of World of Warcraft arena coaching notes. Score ONLY specificity/actionability (1-5): 5 = concrete, grounded in this match\'s actual events, a player could act on it immediately; 1 = generic filler that could apply to any match. Do not re-check factual accuracy — assume the note\'s facts are already verified. Reply with ONLY a JSON object: {"rating": <1-5 integer>, "reason": "<one short sentence>"}.';

  const scored: (NewFindingRow & { rating: number | null; reason: string })[] =
    [];
  for (const f of sample) {
    const audit = JSON.parse(
      readFileSync(
        join(HOME, "relaxed", "items", f.matchId, "audit.json"),
        "utf8",
      ),
    ) as {
      audit: {
        findings: {
          category: string;
          eventIds: string[];
          explanation: string;
        }[];
      };
    };
    const finding = audit.audit.findings.find(
      (ff) => `${ff.category}|${[...ff.eventIds].sort().join(",")}` === f.key,
    );
    if (!finding) {
      console.log(
        `${f.matchId} ${f.key}: could not locate finding text, skipping`,
      );
      continue;
    }
    const prompt = `Coaching finding (category=${finding.category}, severity=${f.severity}):\n"${finding.explanation}"`;
    let rating: number | null = null;
    let reason = "";
    try {
      const raw = await callOnce(client, model, system, prompt);
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m) {
        const parsed = JSON.parse(m[0]) as { rating: number; reason: string };
        rating = parsed.rating;
        reason = parsed.reason;
      }
    } catch (e) {
      reason = `call-error: ${(e as Error).message}`;
    }
    scored.push({ ...f, rating, reason });
    console.log(`${f.matchId} ${f.key}: rating=${rating} (${reason})`);
  }

  writeFileSync(
    join(HOME, "judge-sample.json"),
    JSON.stringify(scored, null, 2),
  );
  const ratings = scored
    .map((s) => s.rating)
    .filter((r): r is number => r !== null);
  const mean = ratings.reduce((a, b) => a + b, 0) / (ratings.length || 1);
  console.log(
    `[judge] scored=${ratings.length}/${scored.length} mean specificity=${mean.toFixed(2)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
