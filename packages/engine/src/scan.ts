import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import type { FileEntry, FileKind } from "@lf/core";

const KINDS: Record<string, FileKind> = {
  ".csv": "csv",
  ".xlsx": "xlsx",
  ".parquet": "parquet",
  ".pdf": "pdf",
  ".pptx": "pptx",
};

export function kindOf(name: string): FileKind {
  return KINDS[extname(name).toLowerCase()] ?? "other";
}

export function isIgnored(name: string): boolean {
  return name.startsWith(".") || name.startsWith("~$") || name.endsWith(".tmp") || name === "Thumbs.db";
}

export function snake(name: string): string {
  const s = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s ? (/^[0-9]/.test(s) ? `f_${s}` : s) : "file";
}

export function uniqueAlias(base: string, taken: Set<string>): string {
  let alias = base;
  for (let i = 2; taken.has(alias); i++) alias = `${base}_${i}`;
  taken.add(alias);
  return alias;
}

export const fileId = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 12);

/** Returns entries plus a private id -> real path map (paths never go in prompts or logs). */
export async function scan(
  folder: string,
  depth: 0 | 1 = 0,
): Promise<{ entries: FileEntry[]; paths: Map<string, string> }> {
  const found: { path: string; name: string }[] = [];
  const walk = async (dir: string, level: number) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (isIgnored(it.name)) continue;
      if (it.isFile()) found.push({ path: join(dir, it.name), name: it.name });
      else if (it.isDirectory() && level < depth) await walk(join(dir, it.name), level + 1);
    }
  };
  await walk(folder, 0);

  const taken = new Set<string>();
  const entries: FileEntry[] = [];
  const paths = new Map<string, string>();
  for (const f of found) {
    const info = await stat(f.path);
    const ext = extname(f.name);
    const alias = uniqueAlias(snake(basename(f.name, ext)), taken);
    const id = fileId(f.path);
    paths.set(id, f.path);
    entries.push({
      id,
      alias,
      kind: kindOf(f.name),
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return { entries, paths };
}
