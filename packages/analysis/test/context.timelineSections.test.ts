import { describe, it, expect } from 'vitest';
import {
  emitRotPressureEntries,
  emitDmgSpikeEntries,
  emitManaMarkerEntries,
  emitFriendlyDeathEntries,
  emitEnemyDeathEntries,
} from '../src/context/matchTimelineSections';
import {
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitPowerType,
  LogEvent,
  ICombatUnit,
} from '@gladlog/parser-compat';
import {
  makeUnit,
  makeAdvancedAction,
  makeAuraEvent,
} from './ported/testHelpers';
import { DMG_SPIKE_THRESHOLD } from '../src/context/timelineHelpers';
import { fmtTime, specToString, IMajorCooldownInfo } from '../src/utils/cooldowns';
import { IPlayerCCTrinketSummary } from '../src/utils/ccTrinketAnalysis';

describe('context.timelineSections.test.ts', () => {
  // ── 1. emitRotPressureEntries ──────────────────────────────────────────────
  describe('emitRotPressureEntries', () => {
    it('empty input -> empty output', () => {
      const entries: [number, string[]][] = [];
      emitRotPressureEntries({
        allPlayers: [],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });

    it('single event -> match Rot Pressure line structure and specific values', () => {
      // Setup player with 3 active DoTs from t=0
      const player = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '30108', 0, 'enemy-1', 'player-1', 'DEBUFF'),
        ],
        // HP < 40% (30%) at t = 2, 3, 4, 5. HP = 50% at t = 0, 1, 6..10.
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(1000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(2000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(3000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(4000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(6000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(7000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(8000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(9000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
        ],
        // No damage event -> ratio evaluates to 1.0 (since totalDmg = 0)
        damageIn: [],
      });

      const entries: [number, string[]][] = [];
      emitRotPressureEntries({
        allPlayers: [player],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      // Emitted at t = 5 (4th consecutive second)
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(5);
      expect(entries[0][1][0]).toBe(
        `${fmtTime(5)}  [ROT PRESSURE]   p-Player1 (${specToString(CombatUnitSpec.Druid_Restoration)}) at 30% HP with 3 active DoTs`
      );
    });

    it('threshold boundaries for consecutive seconds / dot counts / HP / damage ratio', () => {
      // 3 consecutive seconds of low HP -> no emission
      const playerShortHp = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '30108', 0, 'enemy-1', 'player-1', 'DEBUFF'),
        ],
        // HP < 40% at t = 2, 3, 4 (only 3 consecutive seconds)
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(1000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(2000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(3000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(4000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(6000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(7000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(8000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(9000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
        ],
        damageIn: [],
      });

      let entries: [number, string[]][] = [];
      emitRotPressureEntries({
        allPlayers: [playerShortHp],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);

      // 4 consecutive seconds of low HP, but only 2 DoTs -> no emission
      const playerTwoDots = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 0, 'enemy-1', 'player-1', 'DEBUFF'),
        ],
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(1000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(2000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(3000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(4000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(6000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(7000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(8000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(9000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
        ],
        damageIn: [],
      });

      entries = [];
      emitRotPressureEntries({
        allPlayers: [playerTwoDots],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);

      // HP is exactly 40% (not < 40%) -> no emission
      const playerExactHp = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '30108', 0, 'enemy-1', 'player-1', 'DEBUFF'),
        ],
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(1000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(2000, 0, 0, 1000, 400), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(3000, 0, 0, 1000, 400), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(4000, 0, 0, 1000, 400), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 400), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(6000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(7000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(8000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(9000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
        ],
        damageIn: [],
      });

      entries = [];
      emitRotPressureEntries({
        allPlayers: [playerExactHp],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);

      // 4 consecutive seconds, but majority damage is not periodic (periodic ratio = 0.4 < 0.5) -> no emission
      const playerLowPeriodicRatio = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        auraEvents: [
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '980', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '172', 0, 'enemy-1', 'player-1', 'DEBUFF'),
          makeAuraEvent(LogEvent.SPELL_AURA_APPLIED, '30108', 0, 'enemy-1', 'player-1', 'DEBUFF'),
        ],
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(1000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(2000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(3000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(4000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 300), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(6000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(7000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(8000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(9000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 500), advancedActorId: 'player-1' },
        ],
        // Window evaluated is [1000, 5000] ms.
        // Direct dmg = 60, periodic dmg = 40. Total = 100. Ratio = 0.4.
        damageIn: [
          {
            logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: 3000, parameters: [] },
            timestamp: 3000,
            effectiveAmount: 60,
            amount: 60,
            srcUnitId: 'enemy-1',
            srcUnitName: 'Enemy',
            destUnitId: 'player-1',
            destUnitName: 'Player1',
            spellId: '1',
            spellName: 'Direct',
          },
          {
            logLine: { event: 'SPELL_PERIODIC_DAMAGE', timestamp: 3000, parameters: [] },
            timestamp: 3000,
            effectiveAmount: 40,
            amount: 40,
            srcUnitId: 'enemy-1',
            srcUnitName: 'Enemy',
            destUnitId: 'player-1',
            destUnitName: 'Player1',
            spellId: '2',
            spellName: 'Dot',
          },
        ] as any[],
      });

      entries = [];
      emitRotPressureEntries({
        allPlayers: [playerLowPeriodicRatio],
        matchStartMs: 0,
        matchEndMs: 10000,
        matchDurationS: 10,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });
  });

  // ── 2. emitDmgSpikeEntries ─────────────────────────────────────────────────
  describe('emitDmgSpikeEntries', () => {
    it('empty input -> empty output', () => {
      const entries: [number, string[]][] = [];
      emitDmgSpikeEntries({
        pressureWindows: [],
        friends: [],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });

    it('single event -> assert all fields of DMG SPIKE string output', () => {
      const player = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        advancedActions: [
          { ...makeAdvancedAction(15000, 0, 0, 1000, 900), advancedActorId: 'player-1' }, // 90%
          { ...makeAdvancedAction(20000, 0, 0, 1000, 200), advancedActorId: 'player-1' }, // 20%
        ],
        damageIn: [
          // Absorbed event
          {
            logLine: { event: LogEvent.SPELL_ABSORBED, timestamp: 16000, parameters: [] },
            timestamp: 16000,
            effectiveAmount: 0,
            amount: 0,
            absorbedAmount: 200000,
          } as any,
          // Damage from hostile source
          {
            logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: 17000, parameters: [] },
            timestamp: 17000,
            effectiveAmount: 500000,
            amount: 500000,
            srcUnitFlags: 0x0040 | 0x0400, // Hostile player
            srcUnitName: 'Enemy1',
            spellId: '122470',
            spellName: 'Touch of Karma',
          } as any,
        ],
      });

      const pw = {
        fromSeconds: 15,
        toSeconds: 20,
        totalDamage: 5000000, // 5M
        targetName: 'Player1',
        targetSpec: 'Restoration Druid',
      };

      const entries: [number, string[]][] = [];
      emitDmgSpikeEntries({
        pressureWindows: [pw],
        friends: [player],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(15);
      expect(entries[0][1][0]).toBe(
        '0:15–0:20  [DMG SPIKE]   p-Player1 (Restoration Druid): 5.00M in 5s (1000k DPS) (90% -> 20% HP, -14%/s) (0.20M absorbed)\n' +
        '                 Top sources: Enemy1 — Touch of Karma (500k)'
      );
    });

    it('threshold and healed-through boundary checks', () => {
      // Just under DMG_SPIKE_THRESHOLD (300_000) -> no emission
      const player = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        advancedActions: [],
        damageIn: [],
      });

      const pwUnder = {
        fromSeconds: 15,
        toSeconds: 20,
        totalDamage: DMG_SPIKE_THRESHOLD - 1,
        targetName: 'Player1',
        targetSpec: 'Restoration Druid',
      };

      let entries: [number, string[]][] = [];
      emitDmgSpikeEntries({
        pressureWindows: [pwUnder],
        friends: [player],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);

      // Exactly at DMG_SPIKE_THRESHOLD (300_000) -> emits
      const pwExact = {
        fromSeconds: 15,
        toSeconds: 20,
        totalDamage: DMG_SPIKE_THRESHOLD,
        targetName: 'Player1',
        targetSpec: 'Restoration Druid',
      };

      entries = [];
      emitDmgSpikeEntries({
        pressureWindows: [pwExact],
        friends: [player],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toHaveLength(1);

      // Healed through check (HP delta >= 0)
      const playerHealed = makeUnit('player-1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        advancedActions: [
          { ...makeAdvancedAction(15000, 0, 0, 1000, 500), advancedActorId: 'player-1' }, // 50%
          { ...makeAdvancedAction(20000, 0, 0, 1000, 600), advancedActorId: 'player-1' }, // 60%
        ],
        damageIn: [],
      });

      const pwHealed = {
        fromSeconds: 15,
        toSeconds: 20,
        totalDamage: 5000000,
        targetName: 'Player1',
        targetSpec: 'Restoration Druid',
      };

      entries = [];
      emitDmgSpikeEntries({
        pressureWindows: [pwHealed],
        friends: [playerHealed],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toHaveLength(1);
      // Delta is +10% over 5s => +2%/s. String should end with outcomeTag ' — healed through'
      expect(entries[0][1][0]).toContain('(50% -> 60% HP, +2%/s — healed through)');
    });
  });

  // ── 3. emitManaMarkerEntries ───────────────────────────────────────────────
  describe('emitManaMarkerEntries', () => {
    it('empty input -> empty output', () => {
      const entries: [number, string[]][] = [];
      const owner = makeUnit('Player1', { spec: CombatUnitSpec.Druid_Restoration });
      emitManaMarkerEntries({
        owner,
        friends: [],
        enemies: [],
        matchStartMs: 0,
        matchDurationS: 60,
        friendlyDeathAtByName: new Map(),
        enemyDeathAtByName: new Map(),
        pid: (n) => `p-${n}`,
        enemyPid: (n) => `e-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });

    it('single event -> assert friends/enemies mana output structure and exact values', () => {
      const owner = makeUnit('Player1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration, // Friendly healer
        advancedActions: [
          {
            ...makeAdvancedAction(0, 0, 0, 1000, 1000),
            advancedActorId: 'Player1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 10000, max: 10000 }],
          },
          {
            ...makeAdvancedAction(30000, 0, 0, 1000, 1000),
            advancedActorId: 'Player1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 5000, max: 10000 }],
          },
        ] as any[],
      });

      const enemyHealer = makeUnit('Enemy1', {
        name: 'Enemy1',
        spec: CombatUnitSpec.Priest_Holy, // Enemy healer
        advancedActions: [
          {
            ...makeAdvancedAction(0, 0, 0, 1000, 1000),
            advancedActorId: 'Enemy1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 8000, max: 10000 }],
          },
          {
            ...makeAdvancedAction(30000, 0, 0, 1000, 1000),
            advancedActorId: 'Enemy1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 2000, max: 10000 }],
          },
        ] as any[],
      });

      const entries: [number, string[]][] = [];
      emitManaMarkerEntries({
        owner,
        friends: [],
        enemies: [enemyHealer],
        matchStartMs: 0,
        matchDurationS: 40,
        friendlyDeathAtByName: new Map(),
        enemyDeathAtByName: new Map(),
        pid: (n) => `p-${n}`,
        enemyPid: (n) => `e-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(2); // t = 0, t = 30
      expect(entries[0][0]).toBe(0);
      expect(entries[0][1][0]).toBe('0:00  [MANA]   friends p-Player1:100% / enemies e-Enemy1:80%');
      expect(entries[1][0]).toBe(30);
      expect(entries[1][1][0]).toBe('0:30  [MANA]   friends p-Player1:50% / enemies e-Enemy1:20%');
    });

    it('mana marker death boundary check (skip dead healers)', () => {
      const owner = makeUnit('Player1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        advancedActions: [
          {
            ...makeAdvancedAction(0, 0, 0, 1000, 1000),
            advancedActorId: 'Player1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 10000, max: 10000 }],
          },
          {
            ...makeAdvancedAction(30000, 0, 0, 1000, 1000),
            advancedActorId: 'Player1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 5000, max: 10000 }],
          },
        ] as any[],
      });

      const enemyHealer = makeUnit('Enemy1', {
        name: 'Enemy1',
        spec: CombatUnitSpec.Priest_Holy,
        advancedActions: [
          {
            ...makeAdvancedAction(0, 0, 0, 1000, 1000),
            advancedActorId: 'Enemy1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 8000, max: 10000 }],
          },
          {
            ...makeAdvancedAction(30000, 0, 0, 1000, 1000),
            advancedActorId: 'Enemy1',
            advancedActorPowers: [{ type: CombatUnitPowerType.Mana, current: 2000, max: 10000 }],
          },
        ] as any[],
      });

      // Friendly healer Player1 dies at 20 seconds.
      const friendlyDeathAtByName = new Map<string, number>([['Player1', 20]]);
      const entries: [number, string[]][] = [];
      emitManaMarkerEntries({
        owner,
        friends: [],
        enemies: [enemyHealer],
        matchStartMs: 0,
        matchDurationS: 40,
        friendlyDeathAtByName,
        enemyDeathAtByName: new Map(),
        pid: (n) => `p-${n}`,
        enemyPid: (n) => `e-${n}`,
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(2); // t = 0, t = 30
      // At t = 0, Player1 is alive (0 < 20)
      expect(entries[0][1][0]).toBe('0:00  [MANA]   friends p-Player1:100% / enemies e-Enemy1:80%');
      // At t = 30, Player1 is dead (30 >= 20), so Player1 is omitted and only Enemy1 is printed
      expect(entries[1][1][0]).toBe('0:30  [MANA]   enemies e-Enemy1:20%');
    });
  });

  // ── 4. emitFriendlyDeathEntries ────────────────────────────────────────────
  describe('emitFriendlyDeathEntries', () => {
    interface ITestSnapshot {
      placeholder: string;
    }

    it('empty input -> empty output', () => {
      const entries: [number, any[]][] = [];
      emitFriendlyDeathEntries<ITestSnapshot>({
        friendlyDeaths: [],
        unitsByName: new Map(),
        ccTrinketSummaries: [],
        owner: makeUnit('Player1'),
        ownerCDs: [],
        teammateCDs: [],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });

    it('single event -> assert all output line fields, trajectory, and top damage sources', () => {
      const dyingUnit = makeUnit('Player1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 1000), advancedActorId: 'Player1' }, // T-15s (0s): 100%
          { ...makeAdvancedAction(5000, 0, 0, 1000, 900), advancedActorId: 'Player1' }, // T-10s (5s): 90%
          { ...makeAdvancedAction(10000, 0, 0, 1000, 700), advancedActorId: 'Player1' }, // T-5s (10s): 70%
          { ...makeAdvancedAction(12000, 0, 0, 1000, 500), advancedActorId: 'Player1' }, // T-3s (12s): 50%
          { ...makeAdvancedAction(13000, 0, 0, 1000, 300), advancedActorId: 'Player1' }, // T-2s (13s): 30%
          { ...makeAdvancedAction(14000, 0, 0, 1000, 100), advancedActorId: 'Player1' }, // T-1s (14s): 10%
        ],
        damageIn: [
          // Hostile damage event in final 10s (at 12s)
          {
            logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: 12000, parameters: [] },
            timestamp: 12000,
            effectiveAmount: 300000,
            amount: 300000,
            srcUnitFlags: 0x0040 | 0x0400, // Hostile player
            srcUnitName: 'Enemy1',
            spellId: '122470',
            spellName: 'Touch of Karma',
          } as any,
        ],
      });

      const friendlyDeaths = [
        {
          spec: 'Restoration Druid',
          name: 'Player1',
          atSeconds: 15,
          note: 'Lethal',
        },
      ];

      const ccTrinketSummaries: IPlayerCCTrinketSummary[] = [
        {
          playerName: 'Player1',
          playerSpec: 'Restoration Druid',
          trinketType: 'Gladiator',
          trinketCooldownSeconds: 120,
          ccInstances: [],
          trinketUseTimes: [],
          missedTrinketWindows: [],
          rootInstances: [],
          disarmInstances: [],
          interruptInstances: [],
          ccAvoidedInstances: [],
        },
      ];

      const entries: [number, any[]][] = [];
      emitFriendlyDeathEntries<ITestSnapshot>({
        friendlyDeaths,
        unitsByName: new Map([['Player1', dyingUnit]]),
        ccTrinketSummaries,
        owner: dyingUnit,
        ownerCDs: [],
        teammateCDs: [],
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(15);
      const lines = entries[0][1];
      expect(lines).toHaveLength(4);
      expect(lines[0]).toBe('0:15  [DEATH]  p-Player1 (Restoration Druid — friendly) (PvP Trinket available) [Lethal]');
      expect(lines[1]).toEqual({ placeholder: 'snap-15' });
      expect(lines[2]).toBe('               HP: 100% at T-15s → 90% at T-10s → 70% at T-5s → 50% at T-3s → 30% at T-2s → 10% at T-1s → dead');
      expect(lines[3]).toBe('               Top damage in final 10s: Enemy1 — Touch of Karma (300k)');
    });

    it('cooldown availability and lockout boundary checks', () => {
      const dyingUnit = makeUnit('Player1', {
        name: 'Player1',
        spec: CombatUnitSpec.Druid_Restoration,
        reaction: CombatUnitReaction.Friendly,
        advancedActions: [],
        damageIn: [],
      });

      const friendlyDeaths = [
        {
          spec: 'Restoration Druid',
          name: 'Player1',
          atSeconds: 15,
        },
      ];

      const teammateCDs: {
        player: ICombatUnit;
        spec: string;
        cds: IMajorCooldownInfo[];
      }[] = [
        {
          player: dyingUnit,
          spec: 'Restoration Druid',
          cds: [
            {
              spellId: '102342', // Ironbark (NOT whitelisted in USABLE_WHILE_CC_SPELL_IDS)
              spellName: 'Ironbark',
              tag: 'Defensive',
              cooldownSeconds: 60,
              maxChargesDetected: 1,
              casts: [],
              availableWindows: [{ fromSeconds: 0, toSeconds: 60, durationSeconds: 60 }],
              neverUsed: true,
            },
          ],
        },
      ];

      // Case 1: No lockout -> Ironbark should be listed as Unused
      let ccTrinketSummaries: IPlayerCCTrinketSummary[] = [
        {
          playerName: 'Player1',
          playerSpec: 'Restoration Druid',
          trinketType: 'Gladiator',
          trinketCooldownSeconds: 120,
          ccInstances: [],
          trinketUseTimes: [],
          missedTrinketWindows: [],
          rootInstances: [],
          disarmInstances: [],
          interruptInstances: [],
          ccAvoidedInstances: [],
        },
      ];

      let entries: [number, any[]][] = [];
      emitFriendlyDeathEntries<ITestSnapshot>({
        friendlyDeaths,
        unitsByName: new Map([['Player1', dyingUnit]]),
        ccTrinketSummaries,
        owner: dyingUnit,
        ownerCDs: [],
        teammateCDs,
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0][1][0]).toContain('(Unused: Ironbark)');

      // Case 2: Locked out (duration 7s CC starting at 9s covers the entire [10, 15] window) -> Ironbark is NOT listed
      ccTrinketSummaries = [
        {
          playerName: 'Player1',
          playerSpec: 'Restoration Druid',
          trinketType: 'Gladiator',
          trinketCooldownSeconds: 120,
          ccInstances: [
            {
              atSeconds: 9,
              durationSeconds: 7,
              trinketState: 'available_unused',
              spellId: '118',
              spellName: 'Polymorph',
              sourceName: 'Enemy',
              sourceSpec: 'Frost Mage',
            } as any,
          ],
          trinketUseTimes: [],
          missedTrinketWindows: [],
          rootInstances: [],
          disarmInstances: [],
          interruptInstances: [],
          ccAvoidedInstances: [],
        },
      ];

      entries = [];
      emitFriendlyDeathEntries<ITestSnapshot>({
        friendlyDeaths,
        unitsByName: new Map([['Player1', dyingUnit]]),
        ccTrinketSummaries,
        owner: dyingUnit,
        ownerCDs: [],
        teammateCDs,
        matchStartMs: 0,
        pid: (n) => `p-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0][1][0]).not.toContain('(Unused: Ironbark)');
    });
  });

  // ── 5. emitEnemyDeathEntries ───────────────────────────────────────────────
  describe('emitEnemyDeathEntries', () => {
    interface ITestSnapshot {
      placeholder: string;
    }

    it('empty input -> empty output', () => {
      const entries: [number, any[]][] = [];
      emitEnemyDeathEntries<ITestSnapshot>({
        enemyDeaths: [],
        unitsByName: new Map(),
        matchStartMs: 0,
        enemyPid: (n) => `e-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });
      expect(entries).toEqual([]);
    });

    it('single event -> assert death, roster, trajectory, and top damage sources', () => {
      const dyingUnit = makeUnit('Enemy1', {
        name: 'Enemy1',
        spec: CombatUnitSpec.Mage_Frost,
        reaction: CombatUnitReaction.Hostile,
        advancedActions: [
          { ...makeAdvancedAction(0, 0, 0, 1000, 1000), advancedActorId: 'Enemy1' },
          { ...makeAdvancedAction(5000, 0, 0, 1000, 900), advancedActorId: 'Enemy1' },
          { ...makeAdvancedAction(10000, 0, 0, 1000, 700), advancedActorId: 'Enemy1' },
          { ...makeAdvancedAction(12000, 0, 0, 1000, 500), advancedActorId: 'Enemy1' },
          { ...makeAdvancedAction(13000, 0, 0, 1000, 300), advancedActorId: 'Enemy1' },
          { ...makeAdvancedAction(14000, 0, 0, 1000, 100), advancedActorId: 'Enemy1' },
        ],
        damageIn: [
          // Friendly damage event in final 10s (at 12s)
          {
            logLine: { event: LogEvent.SPELL_DAMAGE, timestamp: 12000, parameters: [] },
            timestamp: 12000,
            effectiveAmount: 300000,
            amount: 300000,
            srcUnitFlags: 0x0010 | 0x0400, // Friendly player
            srcUnitName: 'Player1',
            spellId: '122470',
            spellName: 'Touch of Karma',
          } as any,
        ],
      });

      const enemyDeaths = [
        {
          spec: 'Frost Mage',
          name: 'Enemy1',
          atSeconds: 15,
        },
      ];

      const entries: [number, any[]][] = [];
      emitEnemyDeathEntries<ITestSnapshot>({
        enemyDeaths,
        unitsByName: new Map([['Enemy1', dyingUnit]]),
        matchStartMs: 0,
        enemyPid: (n) => `e-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(15);
      const lines = entries[0][1];
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('0:15  [DEATH]  e-Enemy1 (Frost Mage — enemy)');
      expect(lines[1]).toBe('0:15  [ROSTER]  enemy e-Enemy1 removed (dead)');
      expect(lines[2]).toEqual({ placeholder: 'snap-15' });
      expect(lines[3]).toBe('               HP: 100% at T-15s → 90% at T-10s → 70% at T-5s → 50% at T-3s → 30% at T-2s → 10% at T-1s → dead');
      expect(lines[4]).toBe('               Top damage in final 10s: Player1 — Touch of Karma (300k)');
    });

    it('missing unit in unitsByName boundary check', () => {
      const enemyDeaths = [
        {
          spec: 'Frost Mage',
          name: 'Enemy1',
          atSeconds: 15,
        },
      ];

      // Enemy1 is NOT in unitsByName
      const entries: [number, any[]][] = [];
      emitEnemyDeathEntries<ITestSnapshot>({
        enemyDeaths,
        unitsByName: new Map(),
        matchStartMs: 0,
        enemyPid: (n) => `e-${n}`,
        requestSnapshotPlaceholder: (t) => ({ placeholder: `snap-${t}` }),
        addEntry: (t, ...lines) => {
          entries.push([t, lines]);
        },
      });

      expect(entries).toHaveLength(1);
      const lines = entries[0][1];
      // Omit trajectory and top damage sources (so length is 3)
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('0:15  [DEATH]  e-Enemy1 (Frost Mage — enemy)');
      expect(lines[1]).toBe('0:15  [ROSTER]  enemy e-Enemy1 removed (dead)');
      expect(lines[2]).toEqual({ placeholder: 'snap-15' });
    });
  });
});
