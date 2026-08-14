/** Structure dump: what fields does the legacy round object carry for this match? */
import {
  DEFAULT_MATCH_DIR,
  loadLegacyRound,
} from "../../src/explore/storeAccess";

const { legacy } = loadLegacyRound(DEFAULT_MATCH_DIR, "60ab1e8f");
const l = legacy as any;
console.log("top keys:", Object.keys(l).join(", "));
console.log(
  "startTime",
  l.startTime,
  "endTime",
  l.endTime,
  "durMs",
  l.endTime - l.startTime,
);
const units = Object.values(l.units) as any[];
for (const u of units) {
  console.log("--", u.name, u.reaction, u.class, u.spec, "id=", u.id);
}
const owner = units.find((u) => u.name?.startsWith("Minilay"))!;
console.log("owner keys:", Object.keys(owner).join(", "));
for (const k of Object.keys(owner)) {
  const v = (owner as any)[k];
  if (Array.isArray(v)) console.log(`  ${k}: array[${v.length}]`);
}
const aa = owner.advancedActions?.[0];
console.log("advancedAction[0] keys:", aa && Object.keys(aa).join(", "));
console.log("advancedAction[0]:", JSON.stringify(aa)?.slice(0, 600));
const sc = owner.spellCastEvents?.[0];
console.log("spellCastEvents[0] keys:", sc && Object.keys(sc).join(", "));
console.log("spellCastEvents[0]:", JSON.stringify(sc)?.slice(0, 800));
const ae = owner.auraEvents?.[0];
console.log("auraEvents[0]:", JSON.stringify(ae)?.slice(0, 600));
for (const k of [
  "damageIn",
  "damageOut",
  "healIn",
  "healOut",
  "actionIn",
  "actionOut",
]) {
  const v = (owner as any)[k];
  if (v)
    console.log(
      k,
      Array.isArray(v) ? `array[${v.length}]` : typeof v,
      JSON.stringify(v[0])?.slice(0, 500),
    );
}
