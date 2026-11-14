import { describe, expect, it } from "vitest";
import { loadConfig } from "../packages/core/src/index.js";
import { ALLOWED_PROBE_KEYS, collectProbe, recommendTier } from "./probe-lib.js";

describe("probe", () => {
  it("outputs exactly the allowed keys and no identifying data", async () => {
    const r = await collectProbe(loadConfig({}));
    expect(Object.keys(r).sort()).toEqual([...ALLOWED_PROBE_KEYS].sort());
    const text = JSON.stringify(r);
    expect(text).not.toContain(process.env.USERNAME ?? "\u0000no-user");
  }, 30000);
  it("recommends tiers by RAM", () => {
    const { tiers } = loadConfig({}).localModel;
    expect(recommendTier(6, tiers).tier).toBe("none");
    expect(recommendTier(16, tiers).tier).toBe("small");
    expect(recommendTier(32, tiers).tier).toBe("medium");
  });
});
