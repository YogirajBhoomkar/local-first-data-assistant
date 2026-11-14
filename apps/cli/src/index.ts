import { Command } from "commander";
import { EngineError, loadConfig, redactConfig, type QueryResult } from "@lf/core";
import { DuckDbEngine } from "@lf/engine";
import { collectProbe, summarize } from "../../../scripts/probe-lib.js";

const program = new Command().name("lf").description("Local-first desktop agent (developer CLI)");

function printTable(r: QueryResult): void {
  const header = r.columns.map((c) => c.name);
  const body = r.rows.map((row) => row.map((v) => (v === null ? "NULL" : String(v))));
  const widths = header.map((h, i) => Math.min(40, Math.max(h.length, ...body.map((b) => (b[i] ?? "").length))));
  const fmt = (cells: string[]) => cells.map((c, i) => c.slice(0, 40).padEnd(widths[i] ?? 0)).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const b of body) console.log(fmt(b));
  console.log(`\n${r.rowCount} row(s)${r.truncated ? " (truncated)" : ""}, ${r.elapsedMs} ms`);
}

async function withEngine<T>(
  folder: string,
  deep: boolean,
  fn: (engine: DuckDbEngine, entries: Awaited<ReturnType<DuckDbEngine["scanFolder"]>>) => Promise<T>,
  register = true,
): Promise<T> {
  const config = loadConfig();
  const engine = new DuckDbEngine({ cacheDir: config.cacheDir, ...config.engine });
  try {
    const entries = await engine.scanFolder(folder, { depth: deep ? 1 : 0 });
    if (register) await engine.registerFiles(entries);
    return await fn(engine, entries);
  } finally {
    await engine.close();
  }
}

function fail(e: unknown): never {
  if (e instanceof EngineError) console.error(`${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`);
  else console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

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

program
  .command("files")
  .description("List files, kinds, sizes, aliases and warnings")
  .requiredOption("--folder <dir>", "data folder")
  .option("--deep", "also scan one level of sub-folders")
  .action(async (o: { folder: string; deep?: boolean }) => {
    try {
      await withEngine(o.folder, !!o.deep, async (engine, entries) => {
        const schemas = engine.getSchemas();
        for (const e of entries) {
          const mine = schemas.filter((s) => s.fileAlias === e.alias || s.fileAlias.startsWith(`${e.alias}_`));
          const warn = mine.flatMap((s) => (s.warnings ?? []).map((w) => `${s.tableName}: ${w}`));
          console.log(`${e.alias.padEnd(24)} ${e.kind.padEnd(8)} ${(e.sizeBytes / 1024 / 1024).toFixed(2).padStart(9)} MB  ${mine.map((s) => s.tableName).join(", ") || "-"}`);
          for (const w of warn) console.log(`    warning: ${w}`);
        }
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("schema")
  .description("Show table schema and column profile")
  .requiredOption("--folder <dir>", "data folder")
  .option("--table <name>", "only this table, e.g. t_policies")
  .option("--deep", "also scan one level of sub-folders")
  .action(async (o: { folder: string; table?: string; deep?: boolean }) => {
    try {
      await withEngine(o.folder, !!o.deep, async (engine) => {
        for (const s of engine.getSchemas().filter((x) => !o.table || x.tableName === o.table)) {
          console.log(`\n${s.tableName}  (~${s.rowCountEstimate} rows)`);
          for (const w of s.warnings ?? []) console.log(`  warning: ${w}`);
          for (const c of await engine.profile(s.tableName)) {
            const extra = [
              `null ${(c.nullFraction * 100).toFixed(1)}%`,
              `~${c.distinctEstimate} distinct`,
              c.min !== undefined ? `range ${c.min}..${c.max}` : "",
              c.topValues ? `top: ${c.topValues.map((t) => `${t.value}(${t.count})`).join(", ")}` : "",
              c.sampled ? "sampled" : "",
            ].filter(Boolean);
            console.log(`  ${c.name.padEnd(20)} ${c.type.padEnd(12)} ${extra.join(" | ")}`);
          }
        }
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("sql")
  .description("Run guarded read-only SQL")
  .requiredOption("--folder <dir>", "data folder")
  .option("--deep", "also scan one level of sub-folders")
  .argument("<sql>")
  .action(async (sql: string, o: { folder: string; deep?: boolean }) => {
    try {
      await withEngine(o.folder, !!o.deep, async (engine) => printTable(await engine.runReadOnlySql(sql)));
    } catch (e) {
      fail(e);
    }
  });

for (const [name, phase] of [
  ["ask", 3],
  ["bench", 2],
] as const) {
  program
    .command(name)
    .description(`(arrives in Phase ${phase})`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => console.log(`"${name}" arrives in Phase ${phase}.`));
}

await program.parseAsync(process.argv);
