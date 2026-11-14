import type { ChatModelPort, GenerateRequest } from "@lf/core";
import { MockModelAdapter } from "@lf/models";
import type { EvalQuestion } from "./bench.js";

const sys = (r: GenerateRequest) => r.system ?? "";
const find = (qs: EvalQuestion[], text: string) => qs.find((q) => text.includes(`Q: ${q.question}`) || text.includes(`"question":${JSON.stringify(q.question)}`));

/** Oracle models for CI and demos without Ollama: local answers simple questions with the reference SQL. */
export function createOracleModels(questions: EvalQuestion[]): { local: ChatModelPort; remote: ChatModelPort } {
  const local = new MockModelAdapter([
    { match: (r) => sys(r).includes("Classify the user"), reply: (r) => {
        const q = questions.find((x) => r.messages[0]!.content.includes(x.question));
        return { object: { type: q?.label === "hard" ? "explain" : "aggregate", confidence: 0.9 } };
      } },
    { match: (r) => sys(r).includes("You write one DuckDB SQL"), reply: (r) => {
        const q = find(questions, r.messages[0]!.content);
        return q && q.label === "simple" && q.expected.type === "sql"
          ? { object: { sql: q.expected.value, tables: [], confidence: 0.95, needsEscalation: false, reason: "reference" } }
          : { object: { sql: "", tables: [], confidence: 0.2, needsEscalation: true, reason: "hard question" } };
      } },
    { match: (r) => sys(r).includes("Answer the question in 1 to 3"), reply: { text: "Mock local answer." } },
    { match: (r) => sys(r).includes("Suggest up to 3"), reply: { object: { items: [] } } },
  ], "mock-local");

  const remote = new MockModelAdapter([
    { match: (r) => sys(r).includes("You write DuckDB SQL"), reply: (r) => {
        const body = JSON.parse(r.messages[0]!.content) as { question: string; tables?: { table: string }[] };
        const q = questions.find((x) => x.question === body.question);
        const sql = q?.expected.type === "sql" ? String(q.expected.value) : `SELECT COUNT(*) AS n FROM ${body.tables?.[0]?.table ?? "t_policies"}`;
        return { object: { sql: [sql], explanation: "mock remote" } };
      } },
    { match: (r) => sys(r).includes("You answer a business question"), reply: { text: "Mock remote answer." } },
  ], "mock-remote");
  return { local, remote };
}
