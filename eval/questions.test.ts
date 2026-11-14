import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Q = z.object({
  id: z.string().regex(/^[qd]\d{3}$/),
  kind: z.enum(["table", "doc"]),
  files: z.array(z.string()).min(1),
  question: z.string().min(5),
  label: z.enum(["simple", "hard"]),
  expected: z.object({
    type: z.enum(["sql", "value", "contains", "manual"]),
    value: z.unknown(),
  }),
  notes: z.string().min(1),
});

const lines = readFileSync(new URL("./questions.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean);

describe("eval/questions.jsonl", () => {
  const items = lines.map((l) => Q.parse(JSON.parse(l)));
  it("has unique ids", () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
  it("has 18 simple and 12 hard table questions", () => {
    const t = items.filter((i) => i.kind === "table");
    expect(t.filter((i) => i.label === "simple")).toHaveLength(18);
    expect(t.filter((i) => i.label === "hard")).toHaveLength(12);
  });
  it("has 8 simple and 7 hard document questions with contains expectations", () => {
    const d = items.filter((i) => i.kind === "doc");
    expect(d.filter((i) => i.label === "simple")).toHaveLength(8);
    expect(d.filter((i) => i.label === "hard")).toHaveLength(7);
    for (const i of d) {
      expect(i.expected.type, i.id).toBe("contains");
      expect(Array.isArray(i.expected.value), i.id).toBe(true);
    }
  });
  it("gives every simple table question a reference SQL", () => {
    for (const i of items.filter((x) => x.label === "simple" && x.kind === "table"))
      expect(i.expected.type, i.id).toBe("sql");
  });
});
