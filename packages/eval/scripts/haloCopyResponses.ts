import { parseArgs } from "node:util";

import { abDir, resolveEvalHome } from "../src/evalHome.js";
import { copyResponsesAcrossArms } from "../src/halo/buildHaloArms.js";

const { values } = parseArgs({ options: { ab: { type: "string" } } });
if (!values.ab) {
  console.error("--ab required");
  process.exit(1);
}
const n = await copyResponsesAcrossArms(abDir(resolveEvalHome(), values.ab));
console.log(`copied ${n} responses control → treatment`);
