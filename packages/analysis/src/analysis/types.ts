export interface CandidateEvent {
  id: string;
  type: string; // "death" | "cd-waste" | ... (extensible)
  t: number; // seconds from combat start
  unitNames: string[];
  spell?: string;
  /**
   * Spell id (a string, consistent with the rest of the repo). Presentation only:
   * the UI looks it up in SPELL_ICONS_GENERATED to draw an icon. It goes **into
   * neither the prompt nor facts**, so it is not subject to gate audits — for a
   * multi-spell event (e.g. a chain of burst cooldowns) only the first is taken,
   * because the icon is an identifier, not an assertion.
   */
  spellId?: string;
  facts: Record<string, string>; // verifiable, formatted; the only values a finding may cite
}
export interface RawFinding {
  eventIds: string[];
  severity: "high" | "med" | "low";
  category: string;
  title: string;
  explanation: string;
}
export interface Finding extends RawFinding {
  /** Output of the deep-dive round (automatic follow-up questioning): the
   * narration that passed the audit plus evidence chips (relative seconds,
   * clickable into the replay). */
  deepDive?: {
    text: string;
    chips: Array<{
      t: number;
      label: string;
      unitNames: string[];
      /** For the UI's icon lookup only (SPELL_ICONS_GENERATED); left empty for
       * entries with no single spell. */
      spellId?: string;
    }>;
  };
} // explanation is interpolated post-audit
export interface AuditResult {
  findings: Finding[];
  dropped: Array<{ finding: RawFinding; reason: string }>;
}
