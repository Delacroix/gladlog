/**
 * rawStreams.ts — 单源模块:直读 raw.txt 里两条被 parser 丢弃的流(逐事件法力样本 +
 * SPELL_CAST_FAILED 施法意图),供意图守护(cd-hoarded 冤枉修正)、mana-pressure/
 * mana-efficiency 候选、matchExplore 深挖子命令共用(BACKLOG #26,
 * docs/superpowers/plans/2026-08-15-raw-streams.md「数据契约」)。
 *
 * 为什么这里要自己重新实现一份行拆分/时间戳解析,而不是 `import { parseLine } from
 * "@gladlog/parser"`:`packages/analysis` 不依赖 `@gladlog/parser`(只依赖
 * `@gladlog/parser-compat`,后者不重导出 parser 的行级解析函数)——把 parser 加成
 * analysis 的依赖会让 analysis 反向依赖它本不该知道的解析器内部实现。CLAUDE.md
 * 门规谓词即规范的补救条款正是为这种「结构上做不到共享 export」的情形写的:镜像 +
 * 引用具体文件行号的注释 + 一份断言相等的单测(跑在 packages/eval,因为只有它同时
 * 依赖 @gladlog/parser 和 @gladlog/analysis)。三处镜像、三处 parity 测试:
 *   - `splitRawLine`   镜像 packages/parser/src/l1/splitTopLevel.ts 的 `splitLine`/`splitTopLevel`
 *   - `parseRawTimestamp` 镜像 packages/parser/src/l1/timestamp.ts 的 `parseTimestamp`
 *   - `mirrorDecodeAdvanced` 镜像 packages/parser/src/l1/decoders.ts 的 `decodeAdvanced`
 * 三者的 parity 测试见 packages/eval/test/predicateIndex.test.ts。
 *
 * `packages/eval/src/explore/uwcObserved.ts` 原先经 `@gladlog/parser`'s `parseLine`
 * 拿时间戳/行拆分——本任务把它改为直接消费这里的 `splitRawLine`/`parseRawTimestamp`
 * (仍用 `@gladlog/parser` 的 `decodeBaseUnits`/`decodeSpell` 做字段解码,那不是
 * "raw 行解析/时间戳换算"这条规则要单源化的对象),使"raw.txt 一行怎么拆、几点几分"
 * 全仓只有这一处实现,不留第二份。
 */

// ── 行拆分(镜像 packages/parser/src/l1/splitTopLevel.ts) ───────────────────

/**
 * 引号感知的顶层逗号拆分——不识别 `[`/`(` 内的逗号(COMBATANT_INFO 的嵌套数组
 * 会用到),转义反斜杠/引号按 CSV 惯例解码。逐字节镜像
 * packages/parser/src/l1/splitTopLevel.ts:1-52 的 `splitTopLevel` + `decodeToken`
 * (packages/parser/src/l1/splitTopLevel.ts:54-94)。
 */
function splitTopLevelParams(s: string): string[] {
  const results: string[] = [];
  let start = 0;
  let inQuotes = false;
  let squareDepth = 0;
  let parenDepth = 0;
  let hasSpecial = false;

  let i = 0;
  while (i < s.length) {
    const char = s.charCodeAt(i);
    if (inQuotes) {
      if (char === 0x5c /* \ */) {
        hasSpecial = true;
        i += 2;
      } else if (char === 0x22 /* " */) {
        inQuotes = false;
        hasSpecial = true;
        i++;
      } else {
        i++;
      }
    } else {
      if (char === 0x22 /* " */) {
        inQuotes = true;
        hasSpecial = true;
        i++;
      } else if (char === 0x5b /* [ */) {
        squareDepth++;
        i++;
      } else if (char === 0x5d /* ] */) {
        squareDepth--;
        i++;
      } else if (char === 0x28 /* ( */) {
        parenDepth++;
        i++;
      } else if (char === 0x29 /* ) */) {
        parenDepth--;
        i++;
      } else if (
        char === 0x2c /* , */ &&
        squareDepth === 0 &&
        parenDepth === 0
      ) {
        results.push(
          hasSpecial ? decodeParamToken(s, start, i) : s.substring(start, i),
        );
        start = i + 1;
        hasSpecial = false;
        i++;
      } else {
        i++;
      }
    }
  }
  results.push(
    hasSpecial ? decodeParamToken(s, start, i) : s.substring(start, i),
  );
  return results;
}

function decodeParamToken(s: string, start: number, end: number): string {
  let res = "";
  let inQuotes = false;
  let i = start;
  while (i < end) {
    const char = s.charCodeAt(i);
    if (inQuotes) {
      if (char === 0x5c /* \ */) {
        if (i + 1 < end) {
          const nextChar = s.charCodeAt(i + 1);
          if (nextChar === 0x22 /* " */) {
            res += '"';
          } else if (nextChar === 0x5c /* \ */) {
            res += "\\";
          } else {
            res += "\\" + s[i + 1];
          }
          i += 2;
        } else {
          res += "\\";
          i++;
        }
      } else if (char === 0x22 /* " */) {
        inQuotes = false;
        i++;
      } else {
        res += s[i];
        i++;
      }
    } else {
      if (char === 0x22 /* " */) {
        inQuotes = true;
        i++;
      } else {
        res += s[i];
        i++;
      }
    }
  }
  return res;
}

/** One raw.txt line split into its date prefix, event name, and CSV params —
 * quote-aware (spell names / localized failure reasons are double-quoted and
 * may embed escaped quotes). Mirrors
 * packages/parser/src/l1/splitTopLevel.ts:96-124's `splitLine`. `null` for any
 * line that doesn't have the `<date>␠␠<EVENT>,<params>` shape (blank lines,
 * truncated lines, non-combat-log noise) — the caller's contract is to skip
 * those silently, matching parser's own `parseLine` behavior. */
export function splitRawLine(
  line: string,
): { datePart: string; eventName: string; params: string[] } | null {
  const doubleSpaceIndex = line.indexOf("  ");
  if (doubleSpaceIndex === -1) return null;
  const datePart = line.substring(0, doubleSpaceIndex);
  if (!datePart) return null;
  const commaIndex = line.indexOf(",", doubleSpaceIndex + 2);
  if (commaIndex === -1) return null;
  const eventName = line.substring(doubleSpaceIndex + 2, commaIndex);
  if (!eventName) return null;
  const paramsPart = line.substring(commaIndex + 1);
  const params = splitTopLevelParams(paramsPart);
  return { datePart, eventName, params };
}

// ── 时间戳(镜像 packages/parser/src/l1/timestamp.ts) ───────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const maxDays =
    month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maxDays;
}

const formatterCache = new Map<string | undefined, Intl.DateTimeFormat>();

function getFormatter(timezone: string | undefined): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatterOptions: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    hourCycle: "h23",
  };
  if (timezone !== undefined) formatterOptions.timeZone = timezone;
  const formatter = new Intl.DateTimeFormat("en-US", formatterOptions);
  formatterCache.set(timezone, formatter);
  return formatter;
}

function parseIntSlice(s: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return NaN;
    n = n * 10 + c;
  }
  return n;
}

/**
 * Parses a raw.txt line's date prefix (`splitRawLine`'s `datePart`, e.g.
 * `"7/19/2026 04:19:05.269-4"`) into absolute epoch ms. Byte-for-byte mirror
 * of packages/parser/src/l1/timestamp.ts:50-176's `parseTimestamp` — real
 * raw.txt lines always carry an explicit `+N`/`-N` UTC-offset suffix (verified
 * against match 60ab1e8f), which resolves through the explicit-offset branch;
 * the offset-less branch (local-timezone reconstruction via
 * `Intl.DateTimeFormat`) is mirrored too, for lines that lack the suffix. */
export function parseRawTimestamp(
  datePart: string,
  opts?: { timezone?: string },
): number | null {
  let p = 0;
  const slash1 = datePart.indexOf("/", p);
  if (slash1 === -1) return null;
  const month = parseIntSlice(datePart, p, slash1);
  p = slash1 + 1;

  const slash2 = datePart.indexOf("/", p);
  if (slash2 === -1) return null;
  const day = parseIntSlice(datePart, p, slash2);
  p = slash2 + 1;

  const space = datePart.indexOf(" ", p);
  if (space === -1) return null;
  const year = parseIntSlice(datePart, p, space);
  p = space + 1;

  const colon1 = datePart.indexOf(":", p);
  if (colon1 === -1) return null;
  const hour = parseIntSlice(datePart, p, colon1);
  p = colon1 + 1;

  const colon2 = datePart.indexOf(":", p);
  if (colon2 === -1) return null;
  const minute = parseIntSlice(datePart, p, colon2);
  p = colon2 + 1;

  const dot = datePart.indexOf(".", p);
  if (dot === -1) return null;
  const second = parseIntSlice(datePart, p, dot);
  p = dot + 1;

  let suffixIndex = -1;
  let fractionEnd = datePart.length;
  for (let i = p; i < datePart.length; i++) {
    const char = datePart.charCodeAt(i);
    if (char === 0x2b /* + */ || char === 0x2d /* - */) {
      suffixIndex = i;
      fractionEnd = i;
      break;
    }
  }

  const fractionLen = fractionEnd - p;
  if (fractionLen < 1 || fractionLen > 6) return null;

  let ms = 0;
  if (fractionLen >= 3) {
    ms = parseIntSlice(datePart, p, p + 3);
  } else if (fractionLen === 1) {
    ms = parseIntSlice(datePart, p, p + 1) * 100;
  } else if (fractionLen === 2) {
    ms = parseIntSlice(datePart, p, p + 2) * 10;
  }

  if (
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(year) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    Number.isNaN(second) ||
    Number.isNaN(ms)
  ) {
    return null;
  }

  if (!isValidDate(year, month, day)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  if (suffixIndex !== -1) {
    const suffix = datePart.substring(suffixIndex);
    const offset = parseFloat(suffix);
    if (Number.isNaN(offset)) return null;
    const wTarget = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    return wTarget - offset * 3600000;
  }

  const timezone = opts?.timezone;

  try {
    const wTarget = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    let u = wTarget;
    const formatter = getFormatter(timezone);
    for (let i = 0; i < 3; i++) {
      const parts = formatter.formatToParts(new Date(u));
      let pYear = 0,
        pMonth = 0,
        pDay = 0,
        pHour = 0,
        pMinute = 0,
        pSecond = 0;
      for (const part of parts) {
        switch (part.type) {
          case "year":
            pYear = parseInt(part.value, 10);
            break;
          case "month":
            pMonth = parseInt(part.value, 10);
            break;
          case "day":
            pDay = parseInt(part.value, 10);
            break;
          case "hour":
            pHour = parseInt(part.value, 10);
            break;
          case "minute":
            pMinute = parseInt(part.value, 10);
            break;
          case "second":
            pSecond = parseInt(part.value, 10);
            break;
        }
      }
      if (pHour === 24) pHour = 0;
      const w = Date.UTC(pYear, pMonth - 1, pDay, pHour, pMinute, pSecond, ms);
      const diff = w - wTarget;
      if (diff === 0) return u;
      u -= diff;
    }
    return u;
  } catch {
    return null;
  }
}

// ── advanced 块(镜像 packages/parser/src/l1/decoders.ts 的 decodeAdvanced) ──

function parseInt10(val: string | undefined): number {
  if (val === undefined) return NaN;
  return parseInt(val, 10);
}

function parseFloatSafe(val: string | undefined): number {
  if (val === undefined) return NaN;
  return parseFloat(val);
}

/**
 * Mirror of packages/parser/src/l1/decoders.ts:139-181's `decodeAdvanced` —
 * same actorGuid/ownerGuid/hp/maxHp/x/y/facing/mapId fields, same x/y
 * detection (first pair of consecutive params both containing `.`, default
 * offset `at+14`). Exported (not just used internally) so the parity test in
 * packages/eval/test/predicateIndex.test.ts can run it side by side with the
 * real `decodeAdvanced` on real raw.txt lines and assert identical output —
 * the reason this mirror is trustworthy without importing parser.
 */
export function mirrorDecodeAdvanced(
  params: string[],
  at: number,
): {
  actorGuid: string;
  ownerGuid: string;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
  facing: number;
  mapId: number;
} {
  const actorGuid = params[at] ?? "";
  const ownerGuid = params[at + 1] ?? "";
  const hp = parseInt10(params[at + 2]);
  const maxHp = parseInt10(params[at + 3]);

  let xIdx = at + 14;
  let yIdx = at + 15;
  for (let i = at + 4; i < params.length - 1; i++) {
    const val1 = params[i];
    const val2 = params[i + 1];
    if (
      val1 !== undefined &&
      val2 !== undefined &&
      val1.includes(".") &&
      val2.includes(".")
    ) {
      xIdx = i;
      yIdx = i + 1;
      break;
    }
  }

  const x = parseFloatSafe(params[xIdx]);
  const y = parseFloatSafe(params[yIdx]);
  const mapId = parseInt10(params[xIdx + 2]);
  const facing = parseFloatSafe(params[xIdx + 3]);

  return { actorGuid, ownerGuid, hp, maxHp, x, y, facing, mapId };
}

/** `mirrorDecodeAdvanced`'s x/y anchor, exposed so the power block (which
 * sits immediately before x/y, at `xIdx-4..xIdx-1`) can be located without
 * re-deriving the scan. */
function findAdvancedXIdx(params: string[], at: number): number {
  const xIdx = at + 14;
  for (let i = at + 4; i < params.length - 1; i++) {
    const val1 = params[i];
    const val2 = params[i + 1];
    if (
      val1 !== undefined &&
      val2 !== undefined &&
      val1.includes(".") &&
      val2.includes(".")
    ) {
      return i;
    }
  }
  return xIdx;
}

const GUID_PREFIX_RE = /^(Player|Creature|Pet)-/;

/**
 * The advanced-info block's mana entry (WoW power type 0), from a
 * `SPELL_CAST_SUCCESS` (or other advanced-bearing) event's params array.
 *
 * Real layout, verified against match 60ab1e8f raw.txt (2026-08-15; see
 * `docs/superpowers/sdd/2026-08-15-raw-streams/task-1-report.md` for the
 * derivation): the four fields immediately before the x/y position pair are
 * `powerType, currentPower, maxPower, powerCost` — e.g.
 * `...,0,0,9|0,3|270177,5|273000,3|1500,1306.72,1681.85,...` (Holy Paladin
 * casting 永恒之火/Eternal Flame): powerType `"9|0"` = Holy Power(9) and
 * Mana(0) tracked in parallel; currentPower `"3|270177"` and maxPower
 * `"5|273000"` line up index-for-index with powerType, so mana (`"0"`) is at
 * parallel index 1 → 270177/273000. Single-power units (the overwhelming
 * majority of lines) show plain unpiped values, e.g. `...,0,0,0,545,273000,0,
 * 1262.06,...` → powerType `"0"`, current `"545"`, max `"273000"` (this exact
 * line is match 60ab1e8f's healer 10s-before-death mana reading — see the
 * task report's acceptance numbers).
 *
 * Deriving the four fields as `xIdx-4..xIdx-1` (rather than a fixed offset
 * from `at`) makes the count of other fields between `absorb` and `powerType`
 * irrelevant — whatever that count is, it's already absorbed into where
 * `mirrorDecodeAdvanced`'s own x/y scan lands.
 */
export function extractManaFromAdvanced(
  params: string[],
  at: number,
): { mana: number; manaMax: number } | null {
  const xIdx = findAdvancedXIdx(params, at);
  const powerTypeField = params[xIdx - 4];
  const curField = params[xIdx - 3];
  const maxField = params[xIdx - 2];
  if (
    powerTypeField === undefined ||
    curField === undefined ||
    maxField === undefined
  ) {
    return null;
  }
  const types = powerTypeField.split("|");
  const curs = curField.split("|");
  const maxs = maxField.split("|");
  const manaIdx = types.indexOf("0");
  if (manaIdx === -1) return null;
  const mana = Number(curs[manaIdx]);
  const manaMax = Number(maxs[manaIdx]);
  if (!Number.isFinite(mana) || !Number.isFinite(manaMax)) return null;
  return { mana, manaMax };
}

// ── 数据契约 ─────────────────────────────────────────────────────────────

export interface ManaSample {
  tSeconds: number;
  unitGuid: string;
  mana: number;
  manaMax: number;
}

export interface CastFailedEvent {
  tSeconds: number;
  unitGuid: string;
  spellId: number;
  spellName: string;
  reason: string;
}

export interface RawStreams {
  available: boolean;
  manaSamples: ManaSample[];
  castFailed: CastFailedEvent[];
}

/** Offset of the spell/advanced block for a `SPELL_CAST_SUCCESS` line — same
 * "8" `decodeSpell` and "11" `decodeAdvanced` offsets `parseLine` uses for
 * this event (packages/parser/src/l1/parseLine.ts:92-95). */
const CAST_SUCCESS_ADVANCED_AT = 11;

function parseLineInto(
  line: string,
  manaSamples: ManaSample[],
  castFailed: CastFailedEvent[],
  baseMs: number,
  roundDurationS: number | undefined,
): void {
  if (!line) return;
  const split = splitRawLine(line);
  if (!split) return; // malformed line — silently skipped, per Global Constraints
  const { datePart, eventName, params } = split;

  if (eventName !== "SPELL_CAST_FAILED" && eventName !== "SPELL_CAST_SUCCESS") {
    return;
  }

  const absMs = parseRawTimestamp(datePart);
  if (absMs === null) return;
  const tSeconds = (absMs - baseMs) / 1000;

  // Round-boundary clamp (BACKLOG #32, 2026-08-16): a Solo Shuffle raw.txt is
  // ONE file shared by all 6 rounds, so without a bound here a line
  // belonging to a DIFFERENT round of the same lobby still gets a `tSeconds`
  // value relative to THIS round's `baseMs` and is indistinguishable from a
  // same-round sample downstream (`oomWindows`/`castFailedInWindow` have no
  // way to tell). Both directions leak: an earlier round's tail lands at
  // negative `tSeconds`, a later round's head lands past this round's own
  // duration. Zero grace (no slack past `roundDurationS`, no slack before 0):
  // empirically verified on 300/300 sampled non-shuffle ("match"-kind, single
  // round == the whole raw.txt) rounds from the real corpus that ZERO
  // manaSamples/castFailed events ever fall outside `[0, roundDurationS]`
  // even unclamped — real raw.txt logging is already exactly round-scoped
  // when there is only one round, so no boundary-jitter slack is needed (see
  // BACKLOG #32 fix commit for the check). `roundDurationS === undefined`
  // (caller has no round context, e.g. a whole-match tool) skips this check
  // entirely — unbounded, byte-identical to pre-#32 behavior.
  if (
    roundDurationS !== undefined &&
    (tSeconds < 0 || tSeconds > roundDurationS)
  ) {
    return;
  }

  if (eventName === "SPELL_CAST_FAILED") {
    // base units occupy params[0..7] (decodeBaseUnits); spell id/name/school
    // follow at [8]/[9]/[10]; the localized failure reason is [11] — verified
    // against real raw.txt (see module header / task report).
    const unitGuid = params[0];
    const spellIdStr = params[8];
    const spellName = params[9];
    const reason = params[11];
    if (
      unitGuid === undefined ||
      spellIdStr === undefined ||
      spellName === undefined ||
      reason === undefined
    ) {
      return;
    }
    const spellId = parseInt(spellIdStr, 10);
    if (!Number.isFinite(spellId)) return;
    castFailed.push({ tSeconds, unitGuid, spellId, spellName, reason });
    return;
  }

  // SPELL_CAST_SUCCESS: advanced block starts at 11; block-start (actorGuid)
  // must look like a real unit GUID or the line is skipped (Step 1 red line).
  const actorGuid = params[CAST_SUCCESS_ADVANCED_AT];
  if (actorGuid === undefined || !GUID_PREFIX_RE.test(actorGuid)) return;
  const mana = extractManaFromAdvanced(params, CAST_SUCCESS_ADVANCED_AT);
  if (!mana) return;
  manaSamples.push({
    tSeconds,
    unitGuid: actorGuid,
    mana: mana.mana,
    manaMax: mana.manaMax,
  });
}

/**
 * Parses raw.txt's two analysis-relevant streams: per-event mana samples
 * (from `SPELL_CAST_SUCCESS`'s advanced block, powerType 0) and
 * `SPELL_CAST_FAILED` intent events (localized reason kept verbatim). Streams
 * line-by-line (never `rawText.split(",")` across the whole file). `rawText`
 * null/empty (raw.txt missing/unreadable, or advanced combat logging was off
 * for the match) → `{ available: false, manaSamples: [], castFailed: [] }` —
 * every consumer must treat `available:false` as "silently keep existing
 * behavior", never throw (Global Constraint).
 *
 * `baseMs` is the match/round start epoch ms — same time base every other
 * `atSeconds`/`tSeconds` fact in this codebase uses
 * (`buildMatchContext.ts`'s `(event.timestamp - combat.startTime) / 1000`).
 *
 * `roundDurationS` (BACKLOG #32, optional, clamp at the single source):
 * when provided, every sample/event whose `tSeconds` falls outside
 * `[0, roundDurationS]` is excluded at parse time — see `parseLineInto`'s own
 * doc comment for why (Solo Shuffle's raw.txt spans all 6 rounds; without
 * this, a round's builders can silently see another round's data). Every
 * ROUND-scoped caller (production IPC, `matchExplore`'s mana/drink
 * subcommands, `candidateCalibration`'s corpus scan, the P1/P2 A/B harness)
 * MUST pass it — it is optional only so whole-match tools with no single
 * round in scope (none currently call this without a round context; kept
 * optional for forward-compat) can opt out explicitly rather than being
 * forced to invent a duration. Omitting it is unbounded — byte-identical to
 * this function's pre-#32 behavior.
 */
export function parseRawStreams(
  rawText: string | null,
  baseMs: number,
  roundDurationS?: number,
): RawStreams {
  if (!rawText) return { available: false, manaSamples: [], castFailed: [] };
  const manaSamples: ManaSample[] = [];
  const castFailed: CastFailedEvent[] = [];
  for (const line of rawText.split("\n")) {
    parseLineInto(line, manaSamples, castFailed, baseMs, roundDurationS);
  }
  return { available: true, manaSamples, castFailed };
}

/**
 * A round's duration in seconds — the fact `parseRawStreams`'s optional
 * `roundDurationS` clamp expects as its 3rd arg. Single-sourced (BACKLOG #26
 * final review §2.d.2) after this exact `(endTimeMs - startTimeMs) / 1000`
 * derivation was independently hand-written at 6 call sites (desktop's
 * `rawStreamsCache.ts`/`p1p2Ab.ts`, eval's `matchExplore.ts` CLI shell and
 * `manaCalibrationScan.ts` ×3) under TWO different conventions for a
 * missing/malformed `endTimeMs`. This is the GUARDED convention (the one
 * `rawStreamsCache.ts` and `p1p2Ab.ts` already used): non-finite or
 * `endTimeMs < startTimeMs` → `undefined` (unbounded — `parseRawStreams`'s
 * pre-#32, no-clamp behavior), never a fabricated `0`/negative duration,
 * which would silently clamp every sample out.
 */
export function roundDurationSOf(
  startTimeMs: number,
  endTimeMs: number | undefined,
): number | undefined {
  return typeof endTimeMs === "number" &&
    Number.isFinite(endTimeMs) &&
    endTimeMs >= startTimeMs
    ? (endTimeMs - startTimeMs) / 1000
    : undefined;
}

/**
 * The mana reading nearest-at-or-before `tSeconds` for `unitGuid` — `null`
 * when unavailable or when every sample for that unit is strictly after `t`.
 * `manaSamples` is time-ordered (raw.txt lines are chronological), so this
 * can stop scanning the moment a later sample is reached.
 */
export function manaAt(
  s: RawStreams,
  unitGuid: string,
  tSeconds: number,
): { mana: number; manaMax: number } | null {
  if (!s.available) return null;
  let result: ManaSample | null = null;
  for (const sample of s.manaSamples) {
    if (sample.tSeconds > tSeconds) break;
    if (sample.unitGuid === unitGuid) result = sample;
  }
  return result ? { mana: result.mana, manaMax: result.manaMax } : null;
}

/**
 * A mana sample's percent of its own `manaMax`, as a raw (unrounded) value in
 * `[0, 100]` — `0` when `manaMax` is non-positive (a display-safe degenerate
 * case, not a claim the unit is actually empty). Single-sourced because
 * `oomWindows` below and `extendOomTailWithFailedCasts`
 * (`candidateFindings.ts`) both need this exact fact — see
 * docs/predicate-index.md's "Raw log streams" section.
 */
export function manaPct(sample: { mana: number; manaMax: number }): number {
  return sample.manaMax > 0 ? (sample.mana / sample.manaMax) * 100 : 0;
}

/**
 * Contiguous runs of `unitGuid`'s mana samples whose mana% (of that sample's
 * own `manaMax`) is strictly below `thresholdPct` — each run becomes one
 * window spanning its first-to-last below-threshold sample, with the run's
 * lowest raw mana value.
 */
export function oomWindows(
  s: RawStreams,
  unitGuid: string,
  thresholdPct: number,
): Array<{ fromS: number; toS: number; minMana: number }> {
  if (!s.available) return [];
  const windows: Array<{ fromS: number; toS: number; minMana: number }> = [];
  let fromS: number | null = null;
  let toS = 0;
  let minMana = Infinity;
  for (const sample of s.manaSamples) {
    if (sample.unitGuid !== unitGuid) continue;
    const pct = manaPct(sample);
    if (pct < thresholdPct) {
      if (fromS === null) {
        fromS = sample.tSeconds;
        minMana = sample.mana;
      } else {
        minMana = Math.min(minMana, sample.mana);
      }
      toS = sample.tSeconds;
    } else if (fromS !== null) {
      windows.push({ fromS, toS, minMana });
      fromS = null;
      minMana = Infinity;
    }
  }
  if (fromS !== null) windows.push({ fromS, toS, minMana });
  return windows;
}

/**
 * `CastFailedEvent`s for `unitGuid` whose `tSeconds` falls in
 * `[fromS, toS]` (inclusive both ends — matches this codebase's other
 * time-window predicates, e.g. `msInRange`), optionally narrowed to one
 * `spellId`.
 */
export function castFailedInWindow(
  s: RawStreams,
  unitGuid: string,
  fromS: number,
  toS: number,
  spellId?: number,
): CastFailedEvent[] {
  if (!s.available) return [];
  return s.castFailed.filter(
    (c) =>
      c.unitGuid === unitGuid &&
      c.tSeconds >= fromS &&
      c.tSeconds <= toS &&
      (spellId === undefined || c.spellId === spellId),
  );
}

/**
 * Contiguous runs of `unitGuid`'s mana samples where each sample's mana is
 * strictly greater than the previous one ("drinking"/regen segments) — a run
 * spans from the sample immediately before the first rise (the pre-rise
 * baseline) through the last rising sample, with `manaGained` = end − start.
 * A run needs at least one actual rise to be reported (a lone non-rising
 * sample never opens a segment).
 */
export function drinkingSegments(
  s: RawStreams,
  unitGuid: string,
): Array<{ fromS: number; toS: number; manaGained: number }> {
  if (!s.available) return [];
  const segments: Array<{ fromS: number; toS: number; manaGained: number }> =
    [];
  let segStart: ManaSample | null = null;
  let prev: ManaSample | null = null;
  for (const sample of s.manaSamples) {
    if (sample.unitGuid !== unitGuid) continue;
    if (prev && sample.mana > prev.mana) {
      if (!segStart) segStart = prev;
    } else if (segStart && prev) {
      segments.push({
        fromS: segStart.tSeconds,
        toS: prev.tSeconds,
        manaGained: prev.mana - segStart.mana,
      });
      segStart = null;
    } else {
      segStart = null;
    }
    prev = sample;
  }
  if (segStart && prev) {
    segments.push({
      fromS: segStart.tSeconds,
      toS: prev.tSeconds,
      manaGained: prev.mana - segStart.mana,
    });
  }
  return segments;
}
