import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineError } from "@lf/core";
import { DuckDbEngine, snake, uniqueAlias } from "./index.js";

const FIXTURES = resolve(import.meta.dirname, "../test/fixtures");

describe("scan helpers", () => {
  it("snake-cases and dedupes", () => {
    expect(snake("Policies 2024.final")).toBe("policies_2024_final");
    expect(snake("2024 data")).toBe("f_2024_data");
    const taken = new Set<string>();
    expect(uniqueAlias("a", taken)).toBe("a");
    expect(uniqueAlias("a", taken)).toBe("a_2");
    expect(uniqueAlias("a", taken)).toBe("a_3");
  });
});

describe("DuckDbEngine", () => {
  const cache = mkdtempSync(join(tmpdir(), "lf-engine-"));
  const engine = new DuckDbEngine({ cacheDir: cache, queryTimeoutMs: 10000, maxResultRows: 50 });
  let tables: string[] = [];
  let warnings: Record<string, string[] | undefined> = {};

  beforeAll(async () => {
    const entries = await engine.scanFolder(FIXTURES);
    const schemas = await engine.registerFiles(entries);
    tables = schemas.map((s) => s.tableName);
    warnings = Object.fromEntries(schemas.map((s) => [s.tableName, s.warnings]));
  }, 60000);
  afterAll(async () => {
    await engine.close();
    rmSync(cache, { recursive: true, force: true });
  });

  it("registers csv, parquet and xlsx sheets under t_ names", () => {
    expect(tables).toEqual(
      expect.arrayContaining(["t_policies", "t_claims", "t_exposures", "t_budget_plan", "t_budget_actuals", "t_messy_summary"]),
    );
  });
  it("attaches a warning to the messy sheet only", () => {
    expect(warnings.t_messy_summary?.join(" ")).toMatch(/title row/);
    expect(warnings.t_budget_plan).toBeUndefined();
  });
  it("runs a simple query", async () => {
    const r = await engine.runReadOnlySql("SELECT COUNT(*) AS n FROM t_policies");
    expect(r.columns[0]?.name).toBe("n");
    expect(Number(r.rows[0]![0])).toBeGreaterThan(100);
    expect(r.truncated).toBe(false);
  });
  it("runs a join across csv and parquet", async () => {
    const r = await engine.runReadOnlySql(
      "SELECT p.region, COUNT(*) FROM t_policies p JOIN t_exposures e ON p.policy_id = e.policy_id GROUP BY 1",
    );
    expect(r.rowCount).toBeGreaterThan(0);
  });
  it("truncates to maxResultRows", async () => {
    const r = await engine.runReadOnlySql("SELECT * FROM t_policies");
    expect(r.rowCount).toBe(50);
    expect(r.truncated).toBe(true);
  });
  it("maps errors to friendly codes", async () => {
    const code = async (sql: string) => {
      try {
        await engine.runReadOnlySql(sql);
      } catch (e) {
        return (e as EngineError).code;
      }
    };
    expect(await code("SELEC 1")).toMatch(/SYNTAX|FORBIDDEN/);
    expect(await code("SELECT * FROM t_nope")).toBe("UNKNOWN_TABLE");
    expect(await code("SELECT nope FROM t_policies")).toBe("UNKNOWN_COLUMN");
    expect(await code("DROP TABLE t_policies")).toBe("FORBIDDEN");
  });
  it("times out long queries", async () => {
    const err = await engine
      .runReadOnlySql(
        "SELECT COUNT(*) FROM t_policies a, t_policies b, t_policies c, t_policies d WHERE a.premium_amount + b.premium_amount > c.premium_amount * d.limit_amount",
        { timeoutMs: 200 },
      )
      .catch((e: EngineError) => e);
    expect((err as EngineError).code).toBe("TIMEOUT");
  });
  it("cannot be reconfigured or read outside the data folder (layer 1)", async () => {
    // Bypass the guard on purpose by hitting the private connection through a sample call is not
    // possible; instead confirm the guard blocks the attempts and the engine is still healthy.
    await expect(engine.runReadOnlySql("SET enable_external_access=true")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(engine.runReadOnlySql("SELECT * FROM read_csv('C:/Windows/win.ini')")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await engine.runReadOnlySql("SELECT 1");
    expect(r.rowCount).toBe(1);
  });
  it("profiles a table and caches the result", async () => {
    const p = await engine.profile("t_policies");
    const status = p.find((c) => c.name === "status")!;
    expect(status.topValues!.length).toBeGreaterThan(0);
    expect(status.topValues!.length).toBeLessThanOrEqual(5);
    const prem = p.find((c) => c.name === "premium_amount")!;
    expect(typeof prem.min).toBe("number");
    const again = await engine.profile("t_policies");
    expect(again).toEqual(p);
  });
  it("marks profiles sampled for big tables", async () => {
    const p = await engine.profile("t_policies", { sampleRows: 100 });
    expect(p[0]?.sampled).toBe(true);
  });
  it("samples rows with validated columns", async () => {
    const r = await engine.sampleRows("t_policies", 3, ["policy_id", "region"]);
    expect(r.rowCount).toBe(3);
    await expect(engine.sampleRows("t_policies", 3, ["bogus"])).rejects.toMatchObject({ code: "UNKNOWN_COLUMN" });
  });
});
