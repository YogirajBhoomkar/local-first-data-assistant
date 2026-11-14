import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ColumnProfile } from "@lf/core";

/** Small JSON cache in cacheDir, keyed by path hash + size + modified time. */
export interface RegistryItem {
  profile?: ColumnProfile[];
}

export class Registry {
  private data: Record<string, RegistryItem> = {};
  private readonly file: string;
  constructor(cacheDir: string) {
    this.file = join(cacheDir, "registry.json");
  }
  async load(): Promise<void> {
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, RegistryItem>;
    } catch {
      this.data = {};
    }
  }
  get(key: string): RegistryItem | undefined {
    return this.data[key];
  }
  async set(key: string, item: RegistryItem): Promise<void> {
    this.data[key] = item;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data));
    await rename(tmp, this.file);
  }
}
