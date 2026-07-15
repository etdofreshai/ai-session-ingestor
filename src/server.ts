import "dotenv/config";
import express from "express";
import { createAdapters } from "./adapters/index.js";
import { getApiConfig } from "./api-writer.js";
import { StateStore } from "./state-store.js";
import { runSync } from "./sync.js";
import { SOURCE_IDS, type SourceId, type SyncOptions, type SyncResult } from "./types.js";

const app = express();
const port = Number.parseInt(process.env.PORT ?? "3460", 10);
const host = process.env.HOST?.trim() || "0.0.0.0";
const intervalMs = Number.parseInt(process.env.SYNC_INTERVAL_MS ?? "900000", 10);
const autoSync = process.env.AUTO_SYNC === "true";
let activeSync: Promise<SyncResult> | null = null;
let lastResult: SyncResult | null = null;

app.use(express.json({ limit: "1mb" }));

function authorized(authorization: string | undefined): boolean {
  const expected = process.env.INGESTOR_API_TOKEN?.trim();
  return !expected || authorization === `Bearer ${expected}`;
}

function parseOptions(body: unknown): SyncOptions {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const input = body as Record<string, unknown>;
  const options: SyncOptions = {
    dryRun: input.dryRun === true,
    rescan: input.rescan === true,
    baseline: input.baseline === true,
  };
  if (typeof input.since === "string") {
    const parsed = Date.parse(input.since);
    if (Number.isNaN(parsed)) throw new Error("since must be an ISO date");
    options.sinceMs = parsed;
  } else if (typeof input.sinceMs === "number") {
    options.sinceMs = input.sinceMs;
  }
  if (typeof input.maxMessages === "number" && input.maxMessages >= 0) {
    options.maxMessages = Math.floor(input.maxMessages);
  }
  if (Array.isArray(input.sources)) {
    const sources = input.sources.map(String);
    const invalid = sources.filter((source) => !SOURCE_IDS.includes(source as SourceId));
    if (invalid.length) throw new Error(`Unknown sources: ${invalid.join(", ")}`);
    options.sources = sources as SourceId[];
  }
  return options;
}

async function startSync(options: SyncOptions): Promise<SyncResult> {
  if (activeSync) throw new Error("A sync is already running");
  activeSync = runSync(options);
  try {
    lastResult = await activeSync;
    return lastResult;
  } finally {
    activeSync = null;
  }
}

app.get("/", (_request, response) => {
  response.json({
    name: "ai-session-ingestor",
    version: "0.1.0",
    description: "Unified AI coding-session ingestor for Memory Database",
    sources: SOURCE_IDS,
    endpoints: ["/api/health", "/api/status", "/api/sync"],
  });
});

app.get("/api/health", (_request, response) => {
  const adapters = createAdapters();
  response.json({
    status: "ok",
    syncing: activeSync !== null,
    memoryDatabaseConfigured: getApiConfig() !== null,
    sources: Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter.isAvailable()])),
  });
});

app.get("/api/status", async (_request, response) => {
  const state = new StateStore();
  try {
    await state.load();
    response.json({
      service: "ai-session-ingestor",
      status: "ok",
      syncing: activeSync !== null,
      autoSync,
      syncIntervalMs: intervalMs,
      stateCounts: state.counts(),
      lastResult,
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/sync", async (request, response) => {
  if (!authorized(request.headers.authorization)) {
    response.status(401).json({ error: "unauthorized" });
    return;
  }
  if (activeSync) {
    response.status(409).json({ error: "A sync is already running" });
    return;
  }
  try {
    const result = await startSync(parseOptions(request.body));
    response.status(result.totals.failed > 0 ? 207 : 200).json(result);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(port, host, () => {
  console.log(`[ai-session-ingestor] Listening on http://${host}:${port}`);
  console.log(`[ai-session-ingestor] Memory Database API: ${getApiConfig() ? "configured" : "not configured"}`);
  if (autoSync) console.log(`[ai-session-ingestor] Auto-sync every ${intervalMs}ms`);
});

let timer: NodeJS.Timeout | null = null;
if (autoSync) {
  const scheduledSync = (): void => {
    if (activeSync) return;
    void startSync({}).catch((error) => {
      console.error(`[ai-session-ingestor] Scheduled sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  scheduledSync();
  timer = setInterval(scheduledSync, intervalMs);
  timer.unref();
}

function shutdown(): void {
  if (timer) clearInterval(timer);
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
