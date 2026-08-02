/** Language-independent key for flagging a finding: category|sorted(eventIds).
 * Shared by main (aggregation) and renderer (the flag buttons) — a
 * single-source predicate. */
export const findingKey = (f: {
  category: string;
  eventIds?: string[];
}): string => `${f.category}|${[...(f.eventIds ?? [])].sort().join(",")}`;
