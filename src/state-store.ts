import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { envPath } from "./lib/common.js";
import type { SourceId } from "./types.js";

interface SerializedState {
  version: 1;
  sources: Partial<Record<SourceId, string[]>>;
  updatedAt: string;
}

export class StateStore {
  readonly filePath: string;
  private readonly seen = new Map<SourceId, Set<string>>();

  constructor(filePath = path.join(envPath("DATA_DIR", ".data"), "ingest-state.json")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    this.seen.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(await fsPromises.readFile(this.filePath, "utf8")) as SerializedState;
      for (const [source, externalIds] of Object.entries(parsed.sources ?? {})) {
        this.seen.set(source as SourceId, new Set(externalIds));
      }
    } catch (error) {
      throw new Error(
        `Could not load state file ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  has(source: SourceId, externalId: string): boolean {
    return this.seen.get(source)?.has(externalId) ?? false;
  }

  mark(source: SourceId, externalId: string): void {
    const values = this.seen.get(source) ?? new Set<string>();
    values.add(externalId);
    this.seen.set(source, values);
  }

  count(source: SourceId): number {
    return this.seen.get(source)?.size ?? 0;
  }

  counts(): Partial<Record<SourceId, number>> {
    return Object.fromEntries([...this.seen].map(([source, values]) => [source, values.size]));
  }

  async save(): Promise<void> {
    const state: SerializedState = {
      version: 1,
      sources: Object.fromEntries(
        [...this.seen].map(([source, values]) => [source, [...values].sort()]),
      ),
      updatedAt: new Date().toISOString(),
    };
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fsPromises.rename(temporaryPath, this.filePath);
  }
}
