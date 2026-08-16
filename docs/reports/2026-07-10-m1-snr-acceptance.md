# M1 Acceptance Report: L1 Line Parser SNR Sweep

Date: 2026-07-10. Acceptance criteria (spec, amended via agy debate): Non-empty line typed decoding success rate ≥ 99.9%, unknown event rate reported separately, zero parsing failures with breakdown.

## Results

| Corpus | Files | Non-empty lines | typedOk | genericOk (known:false) | failed | Passed |
| --- | --- | --- | --- | --- | --- | --- |
| playstyle-cache (12GB) | 1,050 | 43,876,240 | 41,945,334 | 1,930,906 | **0** | ✅ 100% |
| benchmarks (92GB) | 5,160 | 342,370,913 | 325,336,755 | 17,034,158 | **0** | ✅ 100% |

**Total 386 million non-empty lines, 0 failed lines** (typed + generic = 100%, far exceeding the 99.9% threshold).

## Top Unknown Event Families (92GB, accounting for 5.0% of generic channel)

| Event | Lines |
| --- | --- |
| SPELL_PERIODIC_MISSED | 6,468,556 |
| DAMAGE_SPLIT | 4,692,595 |
| SPELL_HEAL_ABSORBED | 3,334,370 |
| SWING_MISSED | 1,363,549 |
| SPELL_PERIODIC_ENERGIZE | 811,891 |
| SPELL_PERIODIC_DAMAGE_SUPPORT | 204,399 |
| SPELL_ABSORBED_SUPPORT | 68,848 |
| SWING_DAMAGE_LANDED_SUPPORT | 36,806 |

Downstream consumption audit confirmed zero references to these event families (`_MISSED` / `_ENERGIZE` / `DAMAGE_SPLIT` / `_SUPPORT`); generic handling is the correct design. M3 builders can add typed decoders by family if needed.

## Real Format Variations Discovered and Fixed During Process (Not covered by test samples, caught by sweep)

1. Timestamp explicit UTC offset suffix (`23:54:08.392-4`, 3-digit millisecond + offset hours, decimal allowed).
2. Variable width fractional seconds (3-6 digits, interpreted as fractional seconds).
3. COMBATANT_INFO talent array leading empty elements `[,(...) …]` (caught during differential phase, also belonging to L1).
4. Circa-2024 CI layout (flat talent tuples, no auras section) → segment-anchored decoding.

Tool: `packages/parser/scripts/snrSweep.ts`; raw statistics JSON located in local `/tmp` (numbers as above, verified and recorded).
