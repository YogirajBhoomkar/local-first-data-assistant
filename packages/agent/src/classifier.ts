import { RuleClassifier, type ChatModelPort, type Classification, type QuestionClassifier, type QuestionType } from "@lf/core";

const TYPES: QuestionType[] = ["lookup", "filter", "aggregate", "groupby", "topn", "chart", "join", "explain", "other"];

const SYSTEM = `Classify the user's data question into exactly one type:
lookup (show/list rows), filter (rows matching a condition), aggregate (one count/sum/average), groupby (aggregate per category), topn (top or bottom N), chart (asks for a chart), join (needs data from several files), explain (why / explain / forecast / recommend), other.
Reply with JSON: {"type": "<one of the types>", "confidence": 0 to 1}.`;

/** Asks the local model; falls back to the rule classifier on any problem. */
export class LocalModelClassifier implements QuestionClassifier {
  private readonly fallback = new RuleClassifier();
  constructor(private readonly model: ChatModelPort) {}

  async classify(question: string, history: { role: "user" | "assistant"; text: string }[]): Promise<Classification> {
    try {
      const ctx = history.length ? `Earlier: ${history.map((h) => h.text.slice(0, 120)).join(" | ")}\n` : "";
      const r = await this.model.generate({
        system: SYSTEM,
        messages: [{ role: "user", content: `${ctx}Question: ${question}` }],
        responseSchema: {
          type: "object",
          properties: { type: { type: "string", enum: TYPES }, confidence: { type: "number" } },
          required: ["type", "confidence"],
        },
        temperature: 0,
        maxTokens: 60,
      });
      const o = r.object as { type?: string; confidence?: number } | undefined;
      if (o && TYPES.includes(o.type as QuestionType) && typeof o.confidence === "number")
        return { type: o.type as QuestionType, confidence: o.confidence };
    } catch {
      /* fall through */
    }
    return this.fallback.classify(question);
  }
}
