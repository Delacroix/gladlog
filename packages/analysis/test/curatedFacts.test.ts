import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import {
  CURATED_ABILITY_FACTS,
  PROPOSED_FACTS,
} from "../src/data/curatedAbilityFacts";

describe("curated ability facts sign-off", () => {
  it("every entry carries a user approval stamp", () => {
    for (const f of CURATED_ABILITY_FACTS) {
      expect(f.approved, `${f.id} ${f.claim}`).toMatch(
        /^\d{4}-\d{2}-\d{2} user$/,
      );
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = CURATED_ABILITY_FACTS.map(
      (f) => `${f.kind}:${f.id}:${f.claim}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("proposed ability facts (pending sign-off, not CI-enforced)", () => {
  it("carries no approval stamp yet (would be a lie if it did)", () => {
    for (const f of PROPOSED_FACTS) {
      expect("approved" in f, `${f.id} ${f.claim}`).toBe(false);
      expect(f.source.length, `${f.id} source`).toBeGreaterThan(0);
    }
  });
  it("ids are unique per claim kind", () => {
    const keys = PROPOSED_FACTS.map((f) => `${f.kind}:${f.id}:${f.claim}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * Import-boundary test (mechanized version of a code-review "Important"
 * finding): PROPOSED_FACTS is a staging area for unsigned claims. If any
 * consumer imported it directly, an unapproved claim could leak into the
 * pipeline's behavior with nothing but a source-comment promise standing in
 * the way — "don't rely on comments" is the whole point of the sign-off
 * discipline (CLAUDE.md 门规谓词即规范: shared facts need a shared, checked
 * gate, not a convention). This scans real file text rather than trusting
 * that nobody adds an import later.
 */
describe("PROPOSED_FACTS import boundary", () => {
  const SRC_DIR = path.resolve(__dirname, "../src");
  const OWN_FILE = "data/curatedAbilityFacts.ts";

  function listTsFiles(dir: string, base = ""): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const rel = base ? `${base}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        out.push(...listTsFiles(abs, rel));
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        out.push(rel);
      }
    }
    return out;
  }

  it("no file under src/ other than curatedAbilityFacts.ts itself imports PROPOSED_FACTS", () => {
    const offenders: string[] = [];
    for (const rel of listTsFiles(SRC_DIR)) {
      if (rel === OWN_FILE) continue;
      const text = readFileSync(path.join(SRC_DIR, rel), "utf-8");
      if (/\bPROPOSED_FACTS\b/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
