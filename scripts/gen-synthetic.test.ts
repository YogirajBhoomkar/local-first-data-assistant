import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, mulberry32, parseSize } from "./gen-synthetic.js";

describe("gen-synthetic", () => {
  it("parses sizes", () => {
    expect(parseSize("50MB")).toBe(50 * 1024 ** 2);
    expect(() => parseSize("lots")).toThrow();
  });
  it("prng is deterministic", () => {
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });
  it("generates identical files for the same seed and all expected files", async () => {
    const a = mkdtempSync(join(tmpdir(), "lf-a-"));
    const b = mkdtempSync(join(tmpdir(), "lf-b-"));
    try {
      await generate({ outDir: a, sizeBytes: 100_000, seed: 7 });
      await generate({ outDir: b, sizeBytes: 100_000, seed: 7 });
      expect(readdirSync(a).sort()).toEqual(
        ["budget.xlsx", "claims.csv", "exposures.parquet", "messy.xlsx", "policies.csv"],
      );
      expect(readFileSync(join(a, "policies.csv"), "utf8")).toBe(readFileSync(join(b, "policies.csv"), "utf8"));
      expect(readFileSync(join(a, "claims.csv"), "utf8").split("\n")[0]).toContain("claim_id");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  }, 30000);
});
