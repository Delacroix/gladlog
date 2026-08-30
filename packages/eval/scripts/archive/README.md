# `packages/eval/scripts/archive/` — retired deep-dive tooling

These nine scripts belong to the **moment-level deep-dive** form: a second
model round that re-opened one anchor (a death, a kill window) and asked for
deeper claims, evaluated as its own A/B arm.

**Why they are here.** The form was abandoned after an N=20 blind evaluation
in which the deep-dive arm did not beat the default single-round form
(B won 35.7%, inside the noise band). The default `A` shape stayed; the
deep-dive switch was left in the product but off, and the scripts that
generated, gated, and scored that experiment stopped being part of any
workflow. Nothing under `docs/commands/` calls them.

**Why they are kept.** The rulings above are recorded in
`$GLADLOG_EVAL_HOME/ledger.md` and in the 2026-07/08 plan and spec documents
under `docs/superpowers/`, which cite these exact filenames as the tools that
produced the numbers. Deleting them would make the ledger's evidence
unreproducible, which the Verification Rule in `CLAUDE.md` treats as the thing
to avoid; moving them out of the main script directory says "not a standing
workflow" without destroying the record.

| Script                       | What it did                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `deepDiveABGen.ts`           | Built the two arms of a deep-dive prompt-change A/B                 |
| `deepDiveABAudit.ts`         | Scored/audited those arms                                           |
| `deepDiveDisciplineGen.ts`   | Deep-dive discipline smoke — generation stage (evidence pack + prompt) |
| `deepDiveDisciplineAudit.ts` | Deep-dive discipline smoke — audit stage                            |
| `deepDiveGate.ts`            | Teachable-signal gate over a corpus directory                       |
| `deepDiveSignalBreakdown.ts` | Per-spec breakdown of deep-dive signals                             |
| `deepDiveYield.ts`           | Model-independent yield quantification (evidence pieces per anchor) |
| `deepDiveScan.ts`            | Deterministic scan of death-anchored deep-dive packs                |
| `deepDiveOffensiveScan.ts`   | Same, for non-death (offensive) candidates                          |

**Still live, deliberately not archived** (they back rulings that are still
cited and are referenced from active code or docs): `deepDivePositionProbe.ts`,
`deepDivePositionValueGen.ts` / `Audit.ts`, `deepDiveOffensiveValueGen.ts` /
`Audit.ts`.

Running one of these still works — paths inside them are relative to the
package root (`packages/eval/scripts/archive/<name>.ts`), and the two that
read a corpus directory (`deepDiveDisciplineGen`, `deepDiveYield`) resolve it
from `$GLADLOG_EVAL_HOME` and accept `--corpus <dir>`.
