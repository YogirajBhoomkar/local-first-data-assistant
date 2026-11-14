import { writeFile } from "node:fs/promises";
import { collectProbe, summarize } from "./probe-lib.js";

const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

const result = await collectProbe();
console.log(JSON.stringify(result, null, 2));
console.log("\n" + summarize(result));
if (outPath) {
  await writeFile(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nSaved to ${outPath}`);
}
