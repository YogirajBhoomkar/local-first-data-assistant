import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EgressRecord } from "@lf/core";

/**
 * Append-only JSONL. Every send writes a "pending" record BEFORE the network call; the outcome
 * (sent / cancelled / failed) is appended later as a second record with the same egressId.
 * Readers merge by egressId (last wins). Nothing is ever rewritten.
 */
export class EgressLog {
  readonly file: string;
  constructor(cacheDir: string) {
    this.file = join(cacheDir, "egress.log.jsonl");
  }

  async append(record: EgressRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  async readAll(): Promise<EgressRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const merged = new Map<string, EgressRecord>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as EgressRecord;
        merged.set(r.egressId, { ...merged.get(r.egressId), ...r });
      } catch {
        /* skip a corrupt line */
      }
    }
    return [...merged.values()];
  }

  async readLast(n: number): Promise<EgressRecord[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }
}
