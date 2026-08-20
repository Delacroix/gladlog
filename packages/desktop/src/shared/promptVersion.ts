/** Version key of the analysis cache: the main process writing the cache, the
 *  main process reading it, and E2E seeding it all share this one constant.
 *
 *  Single-source predicate — a hardcoded copy fails silently on a version bump:
 *  getCached discards the cache, the panel sits idle, and E2E only reports the
 *  undirected failure "there are no findings".
 *
 *  v3: candidate menu expanded — deaths tagged friendly/enemy (side fact) and
 *  cd-waste events (never-used defensive cooldowns) added; prompt gained an
 *  event legend and whole-round time display.
 *  v4 (D2): the point of view became the log recorder (owner) — a DPS recorder
 *  switched from the healer's point of view to their own, so old caches (the
 *  healer-POV result for the same matchId) must be invalidated; the DPS owner
 *  menu gained four event classes (burst-into-immunity / off-target-in-window /
 *  juked-kick / dr-clipped-cc) plus the <burst_ledger> block. The healer
 *  recorder's prompt is byte-identical, but its cache key rotates with the
 *  version anyway.
 *  v9: HP / short names; v10: teachable-signal gate + owner anchoring + leaving
 *  clean windows blank;
 *  v11: positioning signals (a fourth class); v12: offensive deep dives
 *  (non-death findings);
 *  v13: three team-coordination event classes (death-unused-defensive /
 *  external-unused / wasted-trinket) wired into the prompt's event legend and
 *  mistake list; the menu composition changed, so old caches are void;
 *  v14: the low-pressure guard note (lowPressureUnusedDefensiveNote) — in rounds
 *  where the owner was never attacked, the loadout's owner [UNUSED] mitigation
 *  tags are explicitly declared not to be a teaching point, which also voids the
 *  old caches' false positives of "blamed for unused mitigation despite taking
 *  ≈0 damage".
 *  v15: feasibility gate on dispel blame (user's call, 2026-08-02) — missed
 *  cleanses where the dispeller was CC'd or locked out, or had no line of sight
 *  or was out of range, no longer enter the candidate menu; the timeline
 *  [UNCLEANSED DEBUFF] / [MISSED PURGE OPPORTUNITY] lines gained an exemption
 *  suffix, and windows with fully fresh DR plus evidence of a follow-up CC carry
 *  a cautionary note; false positives of the "blamed for not dispelling
 *  Dragon's Breath / Binding Shot" class in old caches are void.
 *  v16: moment deep dive snapshot opt-in (2026-08-05) -- the deep dive pack
 *  gained a `snapshot` mode (castFlow / GCD-gap context added to the window
 *  pack); the default (non-snapshot) path stays byte-identical, but the pack
 *  *shape* the prompt builder accepts changed, so this counts as a
 *  prompt-generation change under this cache's own rule and the version rolls
 *  regardless of whether a given cached entry happens to be a
 *  snapshot-affected one. Note this is orthogonal to the window cache's own
 *  `:snap` windowKey suffix (see analysis.ts's analyzeWindow) -- that suffix
 *  keeps snapshot-on/off runs of the *same* window from colliding with each
 *  other; this version bump is what invalidates *every* previously-cached
 *  window/run/deepen/coach-chat-resume entry (all consumers of
 *  PROMPT_VERSION), snapshot or not, because they were all produced by the
 *  pre-v16 prompt builder.
 *  v19 (2026-08-06, agy 27/27-dropped attribution): window mode's output
 *  contract line now writes `"findingIndex": 0` (was `"findingIndex":
 *  number`) — agy misread "1-4 entries" as an instruction to number entries
 *  1, 2, 3… and every one of its window-mode deep dives died to
 *  `auditDeepDives`' unknown-finding-index gate; window mode only ever
 *  builds one pack, so the field carried zero information anyway. Paired
 *  with `auditDeepDives`' new single-pack remap (see its own doc comment) —
 *  the prompt change is belt-and-suspenders on top of the code-side fix, not
 *  load-bearing by itself, but the version still rolls because the prompt
 *  text changed.
 *  v17: two deep-dive format hard rules (retest-prep 2026-08-05, fixing the
 *  two format-only death causes the first B-vs-A pass silently ate): never
 *  write a pack key (e.g. p3) as bare prose text (only {{pN.field}}
 *  placeholders are citable), and JSON string values must quote with 「」
 *  rather than unescaped ". Both rules apply in every deep-dive mode (window
 *  and finding, snapshot and non-snapshot alike) -- old deep-dive caches are
 *  void because the prompt text changed, not because of a semantic gate.
 *  v18: window-multi-finding (2026-08-05) -- window-mode deep dives may now
 *  return up to 4 entries per window (was 1) and each entry gains a required
 *  `title`; the window-analysis cache entry shape changed from a single
 *  `text`/`chips` pair to an `entries` list, so old cache entries (the
 *  pre-v18 shape) must miss on read rather than being misread as an empty
 *  `entries` array -- this version bump is what forces that miss.
 *  v20: signal-expansion batch 1 (2026-08-06, BACKLOG #18 second batch) --
 *  three new candidate-menu types (healing-gap / position-mistake / cc-held)
 *  plus a `latencyS` fact added to some missed-cleanse events (a cleanse that
 *  landed, but late) -- both the event menu and the event legend changed, so
 *  old caches (built from the pre-v20 menu/legend) are void.
 *  v21: DEFENSIVE-001 (2026-08-07, BACKLOG #18 second batch) -- a fourth
 *  candidate-menu type, cc-avoidable (a healer ate a full-DR CC of >=3s with
 *  a non-trinket avoidance tool evidenced-and-available beforehand; excludes
 *  instances already covered by cc-locked/wasted-trinket's
 *  trinketState=available_unused to avoid double-charging the same instant)
 *  -- both the event menu and the event legend changed, so old caches are
 *  void.
 *  v22: selection-layer diversity (2026-08-11) -- a four-backend baseline
 *  (.superpowers/sdd/2026-08-05-window-multi-finding/diversity-baseline-report.md)
 *  found all four generation backends over-selecting the legacy missed-
 *  cleanse/missed-purge/cc-locked/wasted-trinket group at +3.4~+7.5pt above
 *  their menu share; buildFindingsPrompt's selection-rule paragraph gained a
 *  sentence capping that group at 2 findings total, so the prompt text
 *  changed -- old cached findings were produced by the pre-cap prompt and are
 *  void, independent of auditFindings' new deterministic backstop (an
 *  audit-layer change, not a prompt-text one, so it alone would not need this
 *  bump -- it rides along with the prompt change).
 *  v23: OFFENSIVE-002 (2026-08-11, BACKLOG #18 second batch) -- a fifth
 *  DPS-owner candidate-menu type, burst-into-mitigation (a burst went into a
 *  target with a major non-immune mitigation cooldown running while a softer
 *  target existed at that same instant) -- both the event menu and the event
 *  legend changed, so old caches are void.
 *  v24: DEFENSIVE-003 (2026-08-11) -- a new healer-owner candidate-menu type,
 *  slow-defensive-response (the enemy opened a pressured offensive-CD burst
 *  window -- damageRatio >= 1.5x the match-average rate -- while the owner had
 *  a defensive off cooldown and was not CC'd, and the first defensive/
 *  external/trinket/mobility/CC response came >8s in or never; dedupe gate
 *  suppresses windows already covered nearby by another candidate) -- both
 *  the event menu and the event legend changed, so old caches are void.
 *  v25 (2026-08-19, covers two prompt changes that land together — the first
 *  SHOULD have bumped this yesterday and was missed, recorded honestly here):
 *  (a) the [KILL ATTEMPTS] block (stun-anchored team kill attempts with
 *  opportunity tier / team focus / failure attribution) plus the
 *  attempt-into-trinket candidate + legend (2026-08-18 wiring, main 740181f7);
 *  (b) off-target-in-window retired from the candidate menu (per-person
 *  exclusivity over 80%-overlapping windows produced mutually-contradictory
 *  accusations; team-level replacement is (a)), and the vulnerability-window
 *  block dropped its CAPITALISED/NOT-CAPITALISED verdict + "× match avg"
 *  ratio (unreachable denominator: 4/3486 windows ever cleared it) — facts
 *  only. Old caches contain the pre-attempts prompt AND findings of a retired
 *  type, so they are void twice over.
 *  v26 (2026-08-19): unconverted-burst retired from the candidate menu (user
 *  ruling C — superseded by the [KILL ATTEMPTS] per-attempt outcome; the type
 *  had 92.1% incidence with no damage floor on what counted as a "burst").
 *  Menu composition changed again, so v25 caches are void. */
// v27 (2026-08-19): missed-sync-window 下架(flag→false,GH #13:归一化转化
// 率持平)+ juked-kick 退役(GH #15:检测无罪但建议不可执行,盲评 2.9/5)。
// 两类候选从菜单消失 → prompt 变 → 旧缓存作废。
// v28 (2026-08-19): cc-locked 退役(GH #14,用户裁定:机会归一化转化率反向
// −4.7pp,赢家更常捂徽章不交;出面事件 98.5% 无已验证可教动作)。菜单少一类、
// LEGACY_TOPIC_TYPES 四族缩三族 → 挑选指令措辞变 → prompt 变 → 旧缓存作废。
// v29 (2026-08-19): wasted-trinket 退役(GH #14 B 组复测,用户裁定:出面事件
// 94.5% 是治疗解自己身上的控 —— healerInCCAt 对 owner 恒 false 的盲区;按使用
// 次数归一化后反向 12.0% vs 10.4%)。菜单再少一类、LEGACY_TOPIC_TYPES 缩为
// 二族 → 挑选指令措辞变 → prompt 变 → 旧缓存作废。
// v30 (2026-08-19): spellEffectData 双层合并的 dispelType 字段级修复 —— override
// 整对象替换曾吞掉 7 个官方 dispelType(冰箱/神圣之盾/沉默/反制射击/法术护佑/
// 天启 Magic + 死亡印记 Bleed;12.1 实战 147 场冰箱被群驱 30 次抓出)。恢复后
// missed-cleanse 194→214 / missed-purge 1507→1534(n=300 验收,其余 17 类零
// 变化)→ 菜单变 → prompt 变 → 旧缓存作废。DB2 真空缺口另见 GH #25。
// v31 (2026-08-20): dr-clipped-cc 退役(GH #17,用户裁定:判据集 {25%,Immune}
// 无合法定义域 —— 25% 档 12.0 已从游戏移除,Immune 档实测两轮全是链窗模型
// 伪影且判别力反向)。同批删除 CC Chains 上下文块的「N immune ⚠ hit immune」
// 提示(同一伪影谓词,向模型断言假事实)→ 菜单与 context 文本双变 →
// 旧缓存作废。
// v32 (2026-08-20): burst-into-immunity 退役(GH #17,用户裁定:伪影修复后
// 按爆发归一化判别力持平 7.1% vs 6.8%,#13 同形)。菜单再少一类 → prompt 变
// → 旧缓存作废。#17 六类处置至此全部收口。
// v33 (2026-08-20): STAYED_IN 代价门接地收紧(GH #16,用户裁定):hpMin<35
// (剂量-反应唯一膝点)替换 85/15 豁免线 —— position-mistake 175→14(−92%),
// 被打掉的 91% 指控实测无结果关联。菜单变 → prompt 变 → 旧缓存作废。
// v34 (2026-08-20): CC_AVOIDABLE_MIN_S 接地收紧 3→4(GH #16,用户裁定:膝点
// 在 4s,3–4s 段 259 条与背景无异)。菜单变 → prompt 变 → 旧缓存作废。
// severity 两处调整(questionable-external→minor / unsynced-burst→average)
// 是 UI 侧标签,不影响 prompt,随本版顺带。
export const PROMPT_VERSION = 34;
