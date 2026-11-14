import type { Mode, NodeId } from "./pipeline";

/** Plain-English explanations shown when a stage is clicked, and the labels drawn on the map. */

export interface NodeInfo {
  label: string;
  sub: string;
  /** Where it runs. */
  where: "laptop" | "cloud";
  what: string;
  why: string;
  /** What this stage can see or send. */
  data: string;
}

export function nodeInfo(id: NodeId, mode: Mode): NodeInfo {
  const t = mode === "table";
  const infos: Record<NodeId, NodeInfo> = {
    question: {
      label: "Question", sub: "your words", where: "laptop",
      what: "You type a question. The last few turns of the chat are kept as short text so follow-ups make sense.",
      why: "Everything starts on this laptop.",
      data: "Only the text of your question and a few earlier turns. Never any result rows from earlier answers.",
    },
    prep: t
      ? {
          label: "Schema pruning", sub: "pick tables + columns", where: "laptop",
          what: "Every file was registered as a read-only table. The system scores each table and column against your question (names, synonyms, and values it has seen) and keeps only the few that matter.",
          why: "Small models do better with a small, focused schema, and a smaller schema means less ever needs to be shared.",
          data: "Table and column names, types, and a few common values. No file paths: the model only ever sees aliases like t_policies.",
        }
      : {
          label: "Document search", sub: "keyword index", where: "laptop",
          what: "PDFs and slide decks were split into passages on this laptop and indexed. The question is matched against them with a BM25 keyword search.",
          why: "No embeddings, no cloud, and the match score tells us how relevant the best passage really is.",
          data: "Passages with their file alias and page or slide number. The files themselves are never sent anywhere.",
        },
    router: {
      label: "Router", sub: "local or remote?", where: "laptop",
      what: "Decides where the question runs, layer by layer: (1) policy: is a remote model allowed at all? (2) hard rules: how many tables, how many columns, words like why or forecast. (3) question type from the local model. (4) try locally, (5) verify, (6) retry once, then escalate.",
      why: "Simple questions stay private and fast. Only questions that need more reasoning are escalated.",
      data: "The question text and the pruned schema. Every reason for the decision is recorded and shown here.",
    },
    local: {
      label: t ? "Local model" : "Local answer", sub: t ? "writes SQL" : "answers + cites", where: "laptop",
      what: t
        ? "A small model running on this laptop (through Ollama) writes one read-only SQL query as strict JSON, with a confidence score and a flag saying whether it thinks it needs help."
        : "A small local model answers from the top passages and must cite them like [file p4]. The answer is checked for a citation and for citing only passages it was given.",
      why: "The model runs on your machine, so no data leaves it.",
      data: t ? "The pruned schema and your question. It returns SQL text only." : "At most about 6,000 characters of passages.",
    },
    exec: t
      ? {
          label: "DuckDB", sub: "runs the SQL", where: "laptop",
          what: "The SQL goes through a read-only guard (one statement, SELECT only, registered tables only, no file or network functions), then runs in DuckDB with a memory limit, a time limit and a row cap.",
          why: "A model must never be able to write, read other files or change settings, so the guard works at two layers: the statement check and a locked-down engine.",
          data: "Your real data, read directly from the files. Nothing is copied out.",
        }
      : {
          label: "Passages", sub: "page + slide refs", where: "laptop",
          what: "The best passages are kept with their page or slide numbers so the answer can cite them.",
          why: "Answers you can check are answers you can trust.",
          data: "Short passages from your documents, on this laptop.",
        },
    verify: {
      label: "Verify", sub: "trust, but check", where: "laptop",
      what: t
        ? "The local answer must pass: the SQL ran in time, it returned rows, the result is not all null, the model's confidence is high enough, and a second generation at a different temperature gives the same result."
        : "The local answer must have a citation, cite only passages it was given, and not say NOT FOUND when the match was strong.",
      why: "A small model can be confidently wrong. If a check fails it retries once, then escalates instead of guessing.",
      data: "Only local results.",
    },
    gate: {
      label: "Privacy gate", sub: "the only way out", where: "laptop",
      what: "The only code allowed to build anything that goes to the remote model. It builds the smallest payload that can answer: schema (and, depending on the privacy level, profiles and a few rows), capped rows and bytes, deny-listed columns removed, masked columns replaced by stable tokens. Whole files never leave.",
      why: "One narrow, audited door instead of many.",
      data: "Exactly the payload you can inspect here and in the log.",
    },
    egress: {
      label: "Egress log", sub: "written first", where: "laptop",
      what: "Before anything is sent, a record is appended to a local log: purpose, tables, columns, rows, bytes and a SHA-256 of the exact payload. The outcome (sent, cancelled, failed) is appended afterwards.",
      why: "You can always answer the question: what did we send, when, and why?",
      data: "Stays on this laptop.",
    },
    remote: {
      label: "Remote model", sub: "gpt-5.1 via LiteLLM", where: "cloud",
      what: "A stronger hosted model. For tables it writes SQL from the schema, which still runs locally; for reasoning questions it may also write the answer from the capped results. For documents it answers from the top passages only.",
      why: "Some questions need more reasoning than a small local model can do.",
      data: "Only the payload shown by the gate. It never sees your files.",
    },
    answer: {
      label: "Answer", sub: "table, chart, sources", where: "laptop",
      what: "The final answer with the data table, a chart chosen from the result shape, the SQL or the citations, and follow-up suggestions.",
      why: "Everything shown here was computed on this laptop.",
      data: "Results stay on screen; they are not re-sent in later turns.",
    },
  };
  return infos[id];
}

export const STEP_TITLES: Record<string, string> = {
  schema: "Find the relevant tables and columns",
  classify: "Classify the question",
  "local-sql": "Local model writes SQL",
  verify: "Verify the local answer",
  answer: "Write the answer",
  "remote-sql": "Remote model writes SQL",
  "remote-docs": "Remote model answers from passages",
  documents: "Search the documents",
  privacy: "Privacy gate",
};
