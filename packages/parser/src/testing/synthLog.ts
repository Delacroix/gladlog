/** Deterministic synthetic combat log: the shared payload for the E2E import
 *  chain and the performance budget. Contains no real player data, scales in
 *  size with eventsPerRound, and is byte-for-byte reproducible for the same
 *  arguments. */
export function synthArenaLog(opts?: {
  /** Event count, which drives the size; all three consumers only need a single
   * match, not multiple rounds. */
  eventsPerRound?: number;
  startMs?: number;
}): string {
  const eventsPerRound = opts?.eventsPerRound ?? 200;
  const startMs = opts?.startMs ?? Date.UTC(2026, 6, 19, 12, 0, 0);

  const players = [
    { guid: "Player-1-0001", name: "Alpha-Realm", flags: "0x511", team: 0 },
    { guid: "Player-1-0002", name: "Bravo-Realm", flags: "0x511", team: 0 },
    { guid: "Player-1-0003", name: "Charlie-Realm", flags: "0x511", team: 0 },
    { guid: "Player-1-0004", name: "Delta-Realm", flags: "0x548", team: 1 },
    { guid: "Player-1-0005", name: "Echo-Realm", flags: "0x548", team: 1 },
    { guid: "Player-1-0006", name: "Foxtrot-Realm", flags: "0x548", team: 1 },
  ];

  const ts = (offsetMs: number): string => {
    const d = new Date(startMs + offsetMs);
    const p2 = (n: number) => String(n).padStart(2, "0");
    const p3 = (n: number) => String(n).padStart(3, "0");
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${p2(
      d.getUTCHours(),
    )}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${p3(
      d.getUTCMilliseconds(),
    )}`;
  };

  const lines: string[] = [];
  const push = (offsetMs: number, body: string) =>
    lines.push(`${ts(offsetMs)}  ${body}`);

  push(0, "ARENA_MATCH_START,1505,41,3v3,1");

  // One COMBATANT_INFO per player (its job: let l3 recognize the roster/specs)
  players.forEach((p, i) => {
    // guid, teamId, 22 zeros, specId, talents[], pvpTalents(), equipment[], interestingAuras[], rating0, rating1
    push(
      10,
      `COMBATANT_INFO,${p.guid},${p.team},0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,${
        70 + i
      },[],(),[],[],0,0`,
    );
  });

  // Main events: attackers rotate onto the other team, healers heal their own;
  // positions advance with the event index
  for (let i = 0; i < eventsPerRound; i++) {
    const t = 1000 + i * 100;
    const src = players[i % 6]!;
    const dst = players[(i + 3) % 6]!;
    const x = (1000 + (i % 50)).toFixed(2);
    const y = (-2000 - (i % 50)).toFixed(2);
    // advanced params tail: actorGuid, ownerGuid, hp, maxHp, 10 zeros/others, x, y, mapId, facing, unk
    // Must have 19 params, and findXIdx must correctly identify the x/y
    // positions (it looks for entries containing a dot after the first 14)
    const advanced = `${src.guid},0000000000000000,100000,100000,0,0,0,0,0,0,0,0,0,0,${x},${y},0,1.0,0`;

    if (i % 3 === 2) {
      push(
        t,
        `SPELL_HEAL,${src.guid},"${src.name}",${src.flags},0x0,${src.guid},"${src.name}",${src.flags},0x0,2061,"Flash Heal",0x2,${advanced},4500,4500,0,0,0`,
      );
    } else {
      push(
        t,
        `SPELL_DAMAGE,${src.guid},"${src.name}",${src.flags},0x0,${dst.guid},"${dst.name}",${dst.flags},0x0,133,"Fireball",0x4,${advanced},3200,3200,0,4,0,0,0,0,nil,nil,nil`,
      );
    }
  }

  const victim = players[5]!;
  const endT = 1000 + eventsPerRound * 100 + 500;
  // The victim must take damage first: A2 invariant death-has-damage (there is
  // an incoming-damage source within 10s before the death). In the main loop,
  // every iteration where dst=players[(i+3)%6]=victim happens to land on the
  // i%3==2 SPELL_HEAL branch, so the victim takes zero damage all match —
  // physically inconsistent; the invariant caught it, so a killing blow is
  // appended here.
  const killer = players[0]!;
  const killAdvanced = `${killer.guid},0000000000000000,100000,100000,0,0,0,0,0,0,0,0,0,0,1000.00,-2000.00,0,1.0,0`;
  push(
    endT - 200,
    `SPELL_DAMAGE,${killer.guid},"${killer.name}",${killer.flags},0x0,${victim.guid},"${victim.name}",${victim.flags},0x0,133,"Fireball",0x4,${killAdvanced},250000,250000,0,4,0,0,0,0,nil,nil,nil`,
  );
  push(
    endT,
    `UNIT_DIED,0000000000000000,nil,0x0,0x0,${victim.guid},"${victim.name}",${victim.flags},0x0,0`,
  );
  push(endT + 500, "ARENA_MATCH_END,0,30,1500,1501");

  return lines.join("\n") + "\n";
}
