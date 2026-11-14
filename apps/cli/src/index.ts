import { Command } from "commander";
import { EngineError, loadConfig, redactConfig, type QueryResult } from "@lf/core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DuckDbEngine } from "@lf/engine";
import { MockModelAdapter, LocalOpenAICompatibleAdapter } from "@lf/models";
import { renderReport, runBench, type EvalQuestion } from "@lf/agent";
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

program
  .command("bench")
  .description("Benchmark local models on the simple table questions")
  .requiredOption("--folder <dir>", "data folder")
  .option("--models <tags>", "comma-separated Ollama model tags")
  .option("--runs <n>", "runs per simple question", "3")
  .option("--mock", "use a scripted mock model (no Ollama needed)")
  .option("--questions <file>", "question set", "eval/questions.jsonl")
  .action(async (o: { folder: string; models?: string; runs: string; mock?: boolean; questions: string }) => {
    try {
      const config = loadConfig();
      const questions = readFileSync(o.questions, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as EvalQuestion);
      const tags = o.mock ? ["mock-oracle"] : (o.models ?? config.localModel.tiers.map((t) => t.model).filter((m): m is string => !!m).join(",")).split(",").map((x) => x.trim()).filter(Boolean);
      const models = tags.map((tag) => ({
        name: tag,
        port: o.mock
          ? new MockModelAdapter([{
              match: (req) => questions.some((q) => req.messages[0]!.content.includes("Q: " + q.question)),
              reply: (req) => {
                const q = questions.find((x) => req.messages[0]!.content.includes("Q: " + x.question))!;
                return q.label === "simple" && q.expected.type === "sql"
                  ? { object: { sql: q.expected.value, tables: [], confidence: 0.95, needsEscalation: false, reason: "reference" } }
                  : { object: { sql: "", tables: [], confidence: 0.2, needsEscalation: true, reason: "hard" } };
              },
            }], tag)
          : new LocalOpenAICompatibleAdapter({ baseUrl: config.localModel.baseUrl, model: tag, timeoutMs: 180_000 }),
      }));
      await withEngine(o.folder, false, async (engine) => {
        const schemas = engine.getSchemas();
        const profiles: Record<string, Awaited<ReturnType<typeof engine.profile>>> = {};
        for (const s of schemas) profiles[s.tableName] = await engine.profile(s.tableName);
        const runs = Math.max(1, Number(o.runs) || 3);
        const result = await runBench({ engine, schemas, profiles, models, questions, runs, prune: { synonyms: config.pruning.synonyms }, onProgress: (m) => console.error(m) });
        const date = new Date().toISOString().slice(0, 10);
        const md = renderReport(result, summarize(await collectProbe(config)), { runs, date });
        mkdirSync("eval/reports", { recursive: true });
        writeFileSync(`eval/reports/model-bench-${date}${o.mock ? "-mock" : ""}.md`, md);
        writeFileSync(`eval/reports/model-bench-${date}${o.mock ? "-mock" : ""}.json`, JSON.stringify(result, null, 2));
        console.log(md);
        console.log(`Saved eval/reports/model-bench-${date}${o.mock ? "-mock" : ""}.md and .json`);
      });
    } catch (e) {
      fail(e);
    }
  });

for (const [name, phase] of [["ask", 3]] as const) {
  program
    .command(name)
    .description(`(arrives in Phase ${phase})`)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => console.log(`"${name}" arrives in Phase ${phase}.`));
}

await program.parseAsync(process.argv);
