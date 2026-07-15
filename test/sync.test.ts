import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/state-store.js";
import { runSync } from "../src/sync.js";
import type { BatchWriteResult, NormalizedMessage, SourceAdapter } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("sync state", () => {
  it("does not submit a confirmed identity twice", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ingestor-sync-"));
    roots.push(root);
    const message: NormalizedMessage = {
      source: "pi",
      externalId: "session:message",
      timestamp: new Date("2026-01-01T00:00:00Z"),
      sender: "Tester",
      recipient: "Pi",
      content: "hello",
      metadata: { role: "human" },
    };
    const adapter: SourceAdapter = {
      id: "pi",
      displayName: "Pi",
      rootPath: root,
      isAvailable: () => true,
      scan: async () => ({ source: "pi", sessions: 1, messages: [message], warnings: [] }),
    };
    let writes = 0;
    const writer = async (messages: NormalizedMessage[]): Promise<BatchWriteResult> => {
      writes += messages.length;
      return { successful: messages.map((item) => ({ message: item, action: "inserted" })), failed: [] };
    };
    const state = new StateStore(path.join(root, "state.json"));

    const first = await runSync({}, { adapters: [adapter], state, writer });
    const second = await runSync({}, { adapters: [adapter], state, writer });

    expect(first.totals.inserted).toBe(1);
    expect(second.totals.pending).toBe(0);
    expect(writes).toBe(1);
  });
});
