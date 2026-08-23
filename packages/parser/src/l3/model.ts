export type MatchResult = "Win" | "Lose" | "Draw" | "Unknown";
export type UnitKind =
  "Player" | "Pet" | "Guardian" | "NPC" | "Object" | "Unknown";
export type Reaction = "Friendly" | "Hostile" | "Neutral" | "Unknown";

export interface GladCombatantInfo {
  teamId: number;
  specId: number;
  personalRating: number;
  talents: unknown[];
  pvpTalents: unknown[];
  equipment: unknown[];
  interestingAuras: { casterGuid: string; spellId: number }[];
}

export interface GladEventBase {
  timestamp: number;
  eventName: string;
  spellId: number;
  spellName: string;
  srcId: string;
  srcName: string;
  destId: string;
  destName: string;
  params: string[];
  /** Index of this event's source line within its match's rawLines (for a
   * shuffle it is the index within the round; the offset into the whole
   * raw.txt is the sum of each round's linesTotal). The anchor for B2
   * provenance deep links. */
  lineIndex?: number;
}

export interface GladHpEvent extends GladEventBase {
  amount: number;
  effectiveAmount: number;
  absorbed?: number;
  /** Critical hit (materialized by the L1 hp-tail decode; after params
   * slimming the tail is no longer persisted with the doc). */
  crit?: boolean;
}

export interface GladAbsorbEvent extends GladEventBase {
  absorbedAmount: number;
  attackerId: string;
  /** Who the shield protected. Three units take part in a SPELL_ABSORBED —
   * attacker (`attackerId`, = `destId`), shield owner (`srcId`) and victim —
   * and only the first two are the keys the L3 arrays are grouped by, so the
   * victim has to travel on the event itself. Params slimming clears
   * `params[4]`, so re-deriving it downstream is not possible. */
  victimId: string;
}

export interface GladSpellEvent extends GladEventBase {}

export interface GladAuraEvent extends GladEventBase {
  auraType: "BUFF" | "DEBUFF";
  amount?: number;
}

export interface GladDeathEvent extends GladEventBase {
  unconscious: boolean;
}

export interface GladAdvancedSample {
  timestamp: number;
  hp: number;
  maxHp: number;
  x: number;
  y: number;
}

export interface GladUnit {
  id: string; // GUID
  name: string;
  ownerId?: string; // pet -> owner
  kind: UnitKind;
  reaction: Reaction;
  classId: number; // Blizzard class ID; 0 = unknown
  specId: number; // Blizzard spec ID; 0 = unknown
  info?: GladCombatantInfo; // Players only
  damageOut: GladHpEvent[];
  damageIn: GladHpEvent[];
  healOut: GladHpEvent[];
  healIn: GladHpEvent[];
  absorbsOut: GladAbsorbEvent[];
  absorbsIn: GladAbsorbEvent[];
  casts: GladSpellEvent[];
  /** SPELL_CAST_START (start of a cast bar; instant casts have no such
   * event). Consumed by the replay cast bars. */
  castStarts: GladSpellEvent[];
  petCasts: GladSpellEvent[];
  auraEvents: GladAuraEvent[];
  actionsOut: GladSpellEvent[];
  actionsIn: GladSpellEvent[];
  deaths: GladDeathEvent[];
  unconsciousEvents: GladDeathEvent[];
  advancedSamples: GladAdvancedSample[];
}

export interface GladMatchBase {
  id: string; // Content hash
  bracket: string;
  zoneId: string;
  startTime: number;
  endTime: number;
  units: Record<string, GladUnit>;
  playerId: string; // GUID of the log's owner
  playerTeamId: number | null;
  winningTeamId: number | null;
  result: MatchResult;
  linesTotal: number;
  linesDropped: number;
  rawLines: string[];
  hasAdvancedLogging: boolean;
  timezone: string;
}

export interface GladMatch extends GladMatchBase {
  kind: "match";
}

export interface GladShuffleRound extends GladMatchBase {
  kind: "shuffleRound";
  sequenceNumber: number;
}

export interface GladShuffle {
  kind: "shuffle";
  rounds: GladShuffleRound[];
  startTime: number;
  endTime: number;
  rawLines: string[];
  result: MatchResult;
}
