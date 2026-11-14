import { describe, expect, it } from "vitest";
import { EngineError } from "@lf/core";
import { guardSql } from "./guard.js";

const T = ["t_policies", "t_claims"];
const ok = (sql: string) => guardSql(sql, T);
const bad = (sql: string, code: string) => {
  try {
    guardSql(sql, T);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection: ${sql}`);
};

describe("guardSql: allowed", () => {
  it("plain select", () => expect(ok("SELECT COUNT(*) FROM t_policies").tables).toEqual(["t_policies"]));
  it("lower and mixed case", () => {
    ok("select * from T_Policies");
    ok("SeLeCt 1");
  });
  it("trailing semicolon and whitespace", () => expect(ok("SELECT 1 FROM t_claims ;  ").sql).toBe("SELECT 1 FROM t_claims"));
  it("CTE", () =>
    ok("WITH x AS (SELECT * FROM t_claims) SELECT COUNT(*) FROM x"));
  it("multiple CTEs and column list", () =>
    ok("WITH a(n) AS (SELECT 1), b AS MATERIALIZED (SELECT * FROM t_claims) SELECT * FROM a, b"));
  it("keywords inside strings are allowed", () =>
    ok("SELECT * FROM t_policies WHERE status = 'drop table; delete from x' OR region = 'it''s read_csv'"));
  it("quoted identifier that looks like a keyword", () =>
    ok('SELECT "delete", "set" FROM t_policies'));
  it("join with alias and ON", () =>
    ok("SELECT c.paid_amount FROM t_claims c JOIN t_policies p ON c.policy_id = p.policy_id WHERE p.region = 'EMEA'"));
  it("comma join", () => expect(ok("SELECT * FROM t_policies p, t_claims c WHERE p.policy_id = c.policy_id").tables).toHaveLength(2));
  it("subquery", () => ok("SELECT * FROM (SELECT region FROM t_policies) s"));
  it("EXTRACT and SUBSTRING FROM are not table refs", () =>
    ok("SELECT EXTRACT(year FROM CAST(loss_date AS DATE)), SUBSTRING(cause FROM 1 FOR 3) FROM t_claims"));
  it("IS DISTINCT FROM", () => ok("SELECT * FROM t_policies WHERE region IS DISTINCT FROM 'EMEA'"));
  it("comments are stripped", () => ok("SELECT /* hi */ 1 -- note\n FROM t_claims"));
  it("replace() scalar function", () => ok("SELECT replace(region, 'E', 'e') FROM t_policies"));
  it("union", () => ok("SELECT 1 FROM t_policies UNION ALL SELECT 2 FROM t_claims"));
});

describe("guardSql: rejected", () => {
  it("insert", () => bad("INSERT INTO t_policies VALUES (1)", "FORBIDDEN"));
  it("drop", () => bad("DROP TABLE t_policies", "FORBIDDEN"));
  it("update/delete hidden after select start", () => bad("SELECT 1; DELETE FROM t_policies", "FORBIDDEN"));
  it("two statements", () => bad("SELECT 1; SELECT 2", "FORBIDDEN"));
  it("comment hiding a second statement", () => bad("SELECT 1 /* x */ ; /* y */ DROP TABLE t_claims", "FORBIDDEN"));
  it("copy", () => bad("COPY (SELECT 1) TO 'x.csv'", "FORBIDDEN"));
  it("attach / install / load", () => {
    bad("ATTACH 'x.db'", "FORBIDDEN");
    bad("INSTALL httpfs", "FORBIDDEN");
    bad("LOAD excel", "FORBIDDEN");
  });
  it("pragma and set", () => {
    bad("PRAGMA database_list", "FORBIDDEN");
    bad("SET enable_external_access=true", "FORBIDDEN");
  });
  it("read_csv at top level", () => bad("SELECT * FROM read_csv('a.csv')", "FORBIDDEN"));
  it("read_csv inside a subquery", () => bad("SELECT * FROM t_policies WHERE policy_id IN (SELECT a FROM read_csv('a.csv'))", "FORBIDDEN"));
  it("read_parquet / glob / read_text", () => {
    bad("SELECT * FROM read_parquet('x')", "FORBIDDEN");
    bad("SELECT * FROM glob('*')", "FORBIDDEN");
    bad("SELECT content FROM read_text('x')", "FORBIDDEN");
  });
  it("file path as a table", () => bad("SELECT * FROM 'data.csv'", "FORBIDDEN"));
  it("http path", () => bad("SELECT * FROM 'https://x.example/a.parquet'", "FORBIDDEN"));
  it("unknown table", () => bad("SELECT * FROM t_nothing", "UNKNOWN_TABLE"));
  it("unknown table in a join", () => bad("SELECT * FROM t_claims JOIN secrets ON 1=1", "UNKNOWN_TABLE"));
  it("schema-qualified table", () => bad("SELECT * FROM main.t_claims", "UNKNOWN_TABLE"));
  it("system tables", () => bad("SELECT * FROM duckdb_settings()", "FORBIDDEN"));
  it("table function", () => bad("SELECT * FROM range(10)", "FORBIDDEN"));
  it("starts with a paren or FROM", () => {
    bad("(SELECT 1)", "FORBIDDEN");
    bad("FROM t_claims", "FORBIDDEN");
  });
  it("empty and unterminated input", () => {
    bad("   ", "SYNTAX");
    bad("SELECT 'abc FROM t_claims", "SYNTAX");
    bad("SELECT 1 /* never closed", "SYNTAX");
  });
  it("dollar-quoted strings", () => bad("SELECT $$x$$", "FORBIDDEN"));
  it("explain / describe", () => {
    bad("EXPLAIN SELECT 1", "FORBIDDEN");
    bad("DESCRIBE t_claims", "FORBIDDEN");
  });
  it("forbidden function used in the select list", () => bad("SELECT getenv('HOME')", "FORBIDDEN"));
});
