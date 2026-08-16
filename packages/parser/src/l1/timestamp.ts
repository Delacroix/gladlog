const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const maxDays =
    month === 2 && (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
      ? 29
      : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= maxDays;
}

// Cache for Intl.DateTimeFormat instances per timezone
const formatterCache = new Map<string | undefined, Intl.DateTimeFormat>();



function getFormatter(timezone: string | undefined): Intl.DateTimeFormat {
  if (formatterCache.has(timezone)) {
    return formatterCache.get(timezone)!;
  }

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
  if (timezone !== undefined) {
    formatterOptions.timeZone = timezone;
  }
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

export function parseTimestamp(
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

  if (Number.isNaN(month) || Number.isNaN(day) || Number.isNaN(year) ||
      Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second) || Number.isNaN(ms)) {
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
    const W_target = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    return W_target - offset * 3600000;
  }

  const timezone = opts?.timezone;

  try {
    const W_target = Date.UTC(year, month - 1, day, hour, minute, second, ms);

    let u = W_target;
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
      const diff = w - W_target;
      if (diff === 0) {
        return u;
      }
      u -= diff;
    }
    return u;
  } catch {
    return null;
  }
}
