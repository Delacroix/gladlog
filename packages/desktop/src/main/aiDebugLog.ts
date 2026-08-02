/**
 * Ring buffer of AI-call debug records (for the developer page): the prompts
 * and raw response text of the last 10 analysis/compare calls. Kept in memory
 * only, never written to disk (prompts contain match details).
 */
export interface AiDebugEntry {
  kind: "analysis" | "compare";
  matchId: string;
  at: number;
  model: string;
  prompt: string;
  raw: string;
}

const MAX = 10;
const entries: AiDebugEntry[] = [];

export function recordAiDebug(e: AiDebugEntry): void {
  entries.unshift(e);
  if (entries.length > MAX) entries.pop();
}

export function listAiDebug(): AiDebugEntry[] {
  return [...entries];
}
