/**
 * Real-model smoke for the new prompt facts ([MANA] / [IMMUNE] / [EMPOWER] /
 * [CC BROKEN]): feed a saved real prompt to the production-parity responder
 * (DeepSeek, same driver the sim harness uses) and print the response, so a
 * human can read whether the model actually consumes the tags — the
 * placeholder-discipline lesson: unit tests cannot see a model misreading a
 * fact, only a real completion can.
 *
 * Usage: npx tsx packages/eval/scripts/smokeTags.ts <promptFile> [...more]
 */
import { readFileSync } from "node:fs";

import {
  buildResponderMessages,
  callDeepseek,
} from "../src/family/deepseekDriver";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: smokeTags.ts <promptFile> [...more]");
  process.exit(1);
}

const TAGS = ["[MANA]", "[IMMUNE", "[EMPOWER", "[CC BROKEN]"];

for (const f of files) {
  const prompt = readFileSync(f, "utf8");
  const present = TAGS.filter((t) => prompt.includes(t));
  console.log(`\n══════ ${f}`);
  console.log(`tags present in prompt: ${present.join(" ") || "(none)"}`);
  const out = await callDeepseek(buildResponderMessages(prompt));
  console.log("── response:\n");
  console.log(out);
  console.log("\n── tag echoes in response:");
  for (const t of TAGS) {
    const mentioned =
      out.includes(t) ||
      (t === "[MANA]" && /mana/i.test(out)) ||
      (t === "[IMMUNE" && /immun/i.test(out)) ||
      (t === "[EMPOWER" && /empower|充能/i.test(out)) ||
      (t === "[CC BROKEN]" && /broke|broken|break/i.test(out));
    console.log(
      `  ${t}: prompt=${present.includes(t)} responseMentions=${mentioned}`,
    );
  }
}
