// Strong causal attribution the "avoid-causality-by-design" policy forbids. This
// checks causal LANGUAGE (enforcing the policy), not causal TRUTH (unverifiable).
// Regex-only by design (semantic/LLM-judge causal audit is deferred to SP-A.1);
// covers the common connectives incl. present-tense outcomes.
//
// Single source consumed by auditFindings.ts (f.explanation), deepDive.ts
// (entry.deepDive, a 3-5 sentence paragraph — see buildDeepDivePrompt), and
// distillRules.ts (description/advice) — do not fork a second pattern list.
const OUTCOME =
  "(died|death|dies|die|lost|loss|lose|loses|wiped|wipe|killed|defeat)";

// Sentence-boundary proxy for the "<connective> ... <outcome>" gap patterns
// below. Must exclude BOTH ascii "." (English sentences) and the CJK
// terminators 。！？ (Chinese sentences never use "."), plus "!"/"?"/newlines
// — otherwise the gap silently spans unrelated sentences in a multi-sentence
// blob (deepDive's own prompt asks for 3-5 sentences per paragraph; zh is
// production's default aiLanguage). Pre-2026-07-31 this class was ASCII-only
// "[^.]*" — invisible as a bug for English text (which does use "." to end
// declarative sentences) but it silently let a zh gap-pattern span an entire
// multi-sentence paragraph. This is a genuine TIGHTENING for BOTH languages,
// not a zh-only fix and not "zero behavior change for English" as an earlier
// version of this comment claimed: the old ASCII-only class also let English
// "!"/"?"-separated clauses bridge together, e.g. "You died? Yes, because
// you overextended." matched the OLD `[^.]*` gap (no "." between "died" and
// "because") but does NOT match this NOT_SENT-bounded version — see
// causalLint.test.ts's dedicated regression fixture for that exact sentence.
const NOT_SENT = "[^.。！？!?\\n]";

// Negation guard: 没有/不会/并未/未曾/从未/未/不 immediately preceding a
// causal connective or certainty marker flips the claim's polarity — "所幸
// 没有导致后续崩盘" ("fortunately did NOT lead to the collapse") is an
// explicit DENIAL of causation, not an assertion of it (real corpus
// sentence, agy-sim-2026-07-31/responses/48357f81.0.txt:14 — confirmed
// false positive on the un-guarded zh-led-to pattern). 2026-07-31 re-review
// round 2: 单字 "未导致"/"不导致" bypassed the original multi-char-only
// list — added (?<!未)(?<!不) below.
//
// Multiple lookbehinds at the same position compose as AND ("none of these
// substrings ends immediately here"), so listing both a single-char negator
// (不/未) and its common multi-char compounds (不会/并未/未曾/从未) is not
// redundant: "未导致" is caught by (?<!未) but NOT by (?<!未曾) (the
// immediately-preceding char there is "曾", not "未"); "未曾导致" is the
// reverse — caught by (?<!未曾) but not by the single-char (?<!未) (the
// immediately-preceding char is "曾"). "从不导致" is caught by the new
// (?<!不) (从不 ends in 不), distinct from the existing (?<!从未).
//
// Over-block check for the new (?<!不): every real 2-3 char Chinese word
// ending in 不 immediately before one of these markers (毫不/绝不/决不/
// 从不 + 导致/造成/致使) is ITSELF a negation of the causal claim, so
// blocking is correct there, not an over-block. "不" that is NOT the
// character immediately before the marker (不仅导致, 不是因为, 不得不...
// 才导致) is unaffected — the lookbehind only inspects the exact position
// immediately before the marker — see causalLint.test.ts's dedicated
// "does not over-block" fixtures.
//
// Scoped to the VERB-like causal connectives (导致/造成/致使/结果就是) and
// certainty adverb (绝对/完全/肯定/必然); NOT applied to
// zh-certainty-survival-idiom (也不会死/就不会死 already embeds 不会 — there
// is no separate "verb" position to guard) or zh-shi-direct-reason. Known
// remaining gap: zh-shi-direct-reason's natural negation is 不是/并非
// ("这不是导致...的直接原因" / "这并非...的直接原因"), which this word list
// does not cover — no corpus evidence of a negated instance found in the
// 300-match sample, so left undone rather than guessed at.
const NEG_LOOKBEHIND =
  "(?<!没有)(?<!不会)(?<!并未)(?<!未曾)(?<!从未)(?<!未)(?<!不)";

// --- Chinese causal-certainty patterns (2026-07-31). Production default
// aiLanguage is zh; a 300-match agy production simulation
// ($HOME/code/gladlog-eval-private/agy-sim-2026-07-31/deep-read.md, Part 4)
// found 8 real Chinese causal-certainty overclaims across 6 response files
// that the English-only patterns above cannot see. Two failure classes:
//   (a) certainty-survival: a hedged prompt fact (e.g. "margin >15% max HP")
//       gets upgraded to unconditional certainty (绝对/完全/肯定/必然 + 死不
//       了/存活/活下来, or the frozen idioms 也不会死/就不会死) — the most
//       dangerous instance is when this happens ON the audited decisive
//       counterfactual line itself (2 of the 8 cases).
//   (b) direct-causation: a decision/damage instance asserted as THE cause
//       of a death/loss (导致.../直接.../是...的直接原因).
// Deliberately narrow: no bare 也/就/才 as standalone adverbs (they are
// load-bearing common words in ordinary Chinese and would drown the gate in
// false positives — see causalLint.test.ts for the legal-possibility
// negative fixtures, e.g. 可能/或许/大概率/有机会 + 活, that must NOT match).
const ZH_OUTCOME =
  "(死亡|阵亡|猝死|战败|团灭|输了|输掉|落败|崩盘|崩溃|失利|失败|告负)";
const ZH_SURVIVE = "(死不了|不会死|可以存活|活下来|能活下来|存活下来)";
const ZH_CERTAINTY_ADV = "(绝对|完全|肯定|必然)";

const PATTERNS: Array<[string, RegExp]> = [
  [
    "outcome-because",
    new RegExp(`\\b${OUTCOME}\\b${NOT_SENT}*\\bbecause\\b`, "i"),
  ],
  [
    "because-outcome",
    new RegExp(`\\bbecause\\b${NOT_SENT}*\\b${OUTCOME}\\b`, "i"),
  ],
  // "cost <the game/round/match/series>" — the causal-outcome form. Narrowed so
  // "it cost you nothing to try" (resource-cost observation) does NOT false-drop.
  [
    "cost-outcome",
    /\bcost (you |us |him |her |them |the team )?(the )?(game|round|match|series)\b/i,
  ],
  ["got-killed", /\bgot (you|him|her|them|the team) killed\b/i],
  // "that's/which is why <negative outcome>" — a causal explanation of a loss.
  // Narrowed to require a negative outcome so positive reinforcement ("which is
  // why you survived") is not dropped.
  [
    "thats-why-outcome",
    new RegExp(
      `\\b(that'?s|this is|which is) why\\b${NOT_SENT}*\\b${OUTCOME}\\b`,
      "i",
    ),
  ],
  [
    "led-to",
    new RegExp(
      `\\b(led to|resulted in|caused)\\b${NOT_SENT}*\\b${OUTCOME}\\b`,
      "i",
    ),
  ],
  // --- zh mirrors of the English connective patterns above (same semantics) ---
  [
    "zh-outcome-because",
    new RegExp(`${ZH_OUTCOME}${NOT_SENT}*${NEG_LOOKBEHIND}因为`),
  ],
  [
    "zh-because-outcome",
    new RegExp(`${NEG_LOOKBEHIND}因为${NOT_SENT}*${ZH_OUTCOME}`),
  ],
  // 导致/造成/致使 — mirrors "led to/resulted in/caused". Also independently
  // catches the "是...的直接原因" / "是直接导致...的原因" cases below since
  // both contain 导致+outcome within the gap. NEG_LOOKBEHIND guards against
  // "没有导致"/"未曾造成" etc (explicit denial of causation).
  [
    "zh-led-to",
    new RegExp(
      `${NEG_LOOKBEHIND}(导致|造成|致使)${NOT_SENT}{0,20}${ZH_OUTCOME}`,
    ),
  ],
  // --- zh-specific: certainty-survival (no English equivalent needed; the
  // English gate has nothing that upgrades a hedge to flat certainty this way) ---
  [
    "zh-certainty-survival-adv",
    new RegExp(
      `${NEG_LOOKBEHIND}${ZH_CERTAINTY_ADV}${NOT_SENT}{0,12}${ZH_SURVIVE}`,
    ),
  ],
  // Frozen idioms 也不会死/就不会死 — literal (not "也"/"就" as standalone
  // adverbs, which are two of the most common words in Chinese).
  ["zh-certainty-survival-idiom", /(也不会死|就不会死)/],
  // --- zh-specific: direct-causation ---
  // "X的结果就是...猝死" — the "结果就是" (the result is) framing is what
  // carries the causal claim, NOT bare "直接" (which corpus hand-review
  // showed is usually just a manner adverb — "你直接阵亡了" = "you died
  // right there", describing immediacy, not attributing a cause; a bare
  // 直接+OUTCOME pattern was dropped after 2026-07-31 corpus review flagged
  // it as the dominant false-positive source, e.g. "队友...直接猝死" as a
  // plain damage narration).
  [
    "zh-result-outcome",
    new RegExp(`${NEG_LOOKBEHIND}结果就是${NOT_SENT}{0,30}${ZH_OUTCOME}`),
  ],
  // "是...的直接原因" — e.g. "这是导致输掉比赛的直接原因". Requires an actual
  // ZH_OUTCOME word in the gap (not just any "是...的直接原因"): corpus
  // hand-review found this pattern fires just as readily on POSITIVE
  // attribution ("这也是你们获胜的直接原因" — "the direct reason you WON"),
  // which the policy explicitly allows (mirrors English's "which is why you
  // survived" staying unflagged) — bare "是...的直接原因" without an
  // outcome-word gate cannot tell winning from losing.
  [
    "zh-shi-direct-reason",
    new RegExp(`是${NOT_SENT}{0,20}${ZH_OUTCOME}${NOT_SENT}{0,20}的直接原因`),
  ],
];

export function causalLint(text: string): string[] {
  const v: string[] = [];
  for (const [label, rx] of PATTERNS)
    if (rx.test(text)) v.push(`strong causal claim (${label})`);
  return v;
}
