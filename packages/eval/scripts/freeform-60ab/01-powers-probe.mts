/** Probe: are advancedActorPowers populated anywhere (mana / holy power)? */
import {
  DEFAULT_MATCH_DIR,
  loadLegacyRound,
} from "../../src/explore/storeAccess";

const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, "60ab1e8f");
const units = Object.values((legacy as any).units) as any[];
const owner = units.find((u) => u.name === "Minilay-Illidan-US")!;
let withPowers = 0;
const samples: string[] = [];
for (const a of owner.advancedActions) {
  if (a.advancedActorPowers && a.advancedActorPowers.length > 0) {
    withPowers++;
    if (samples.length < 5)
      samples.push(
        `${a.timestamp} powers=${JSON.stringify(a.advancedActorPowers)} ev=${a.logLine?.event}`,
      );
  }
}
console.log(
  `owner advancedActions=${owner.advancedActions.length} withPowers=${withPowers}`,
);
for (const s of samples) console.log(s);
// also check event types distribution
const evs = new Map<string, number>();
for (const a of owner.advancedActions) {
  const e = a.logLine?.event ?? "?";
  evs.set(e, (evs.get(e) ?? 0) + 1);
}
console.log([...evs.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
