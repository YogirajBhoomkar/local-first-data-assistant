import { Command } from "commander";
import { loadConfig, redactConfig } from "@lf/core";
import { collectProbe, summarize } from "../../../scripts/probe-lib.js";

const program = new Command().name("lf").description("Local-first desktop agent (developer CLI)");

program
  .command("probe")
  .description("Print a hardware capability report")
  .option("--json", "print JSON only")
  .action(async (opts: { json?: boolean }) => {
    const r = await collectProbe();
    console.log(opts.json ? JSON.stringify(r, null, 2) : summarize(r));
  });

program
  .command("config")
  .description("Configuration commands")
  .command("show")
  .description("Print the effective config (secrets redacted)")
  .action(() => {
    console.log(JSON.stringify(redactConfig(loadConfig()), null, 2));
  });

const placeholders: [string, number][] = [
  ["files", 1],
  ["sql", 1],
  ["ask", 3],
  ["bench", 2],
];
for (const [name, phase] of placeholders) {
  program
    .command(name)
    .description(`(arrives in Phase ${phase})`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => console.log(`"${name}" arrives in Phase ${phase}.`));
}

await program.parseAsync(process.argv);
