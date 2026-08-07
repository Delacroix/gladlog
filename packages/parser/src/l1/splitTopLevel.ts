export function splitTopLevel(s: string): string[] {
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
      } else if (char === 0x2c /* , */ && squareDepth === 0 && parenDepth === 0) {
        results.push(hasSpecial ? decodeToken(s, start, i) : s.substring(start, i));
        start = i + 1;
        hasSpecial = false;
        i++;
      } else {
        i++;
      }
    }
  }
  results.push(hasSpecial ? decodeToken(s, start, i) : s.substring(start, i));
  return results;
}

function decodeToken(s: string, start: number, end: number): string {
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
            res += '\\';
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

export function splitLine(line: string): {
  datePart: string;
  eventName: string;
  params: string[];
} | null {
  const doubleSpaceIndex = line.indexOf("  ");
  if (doubleSpaceIndex === -1) {
    return null;
  }
  const datePart = line.substring(0, doubleSpaceIndex);
  if (!datePart) {
    return null;
  }
  const commaIndex = line.indexOf(",", doubleSpaceIndex + 2);
  if (commaIndex === -1) {
    return null;
  }
  const eventName = line.substring(doubleSpaceIndex + 2, commaIndex);
  if (!eventName) {
    return null;
  }
  const paramsPart = line.substring(commaIndex + 1);
  const params = splitTopLevel(paramsPart);
  return {
    datePart,
    eventName,
    params,
  };
}
