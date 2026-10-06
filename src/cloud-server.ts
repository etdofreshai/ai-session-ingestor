import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { writeMessages } from "./api-writer.js";
import { messageFromRow, rolloutRows, usageRecord, type CloudRow, type CloudThread } from "./cloud-records.js";

const execFileP = promisify(execFile);
const dataDir = path.resolve(process.env.DATA_DIR ?? "/data");
const exportDir = path.resolve(process.env.CLOUD_EXPORT_DIR ?? "/export/codex");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(exportDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "cloud.sqlite"));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, body TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS items_thread ON items(thread_id);
  CREATE INDEX IF NOT EXISTS usage_thread ON usage(thread_id);
`);
// Forked threads may retain original turn/item IDs. Keep identity scoped to thread.
db.exec(`
  CREATE TABLE IF NOT EXISTS thread_turns (
    id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(thread_id,id)
  );
  CREATE TABLE IF NOT EXISTS thread_items (
    id TEXT NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id,id)
  );
  INSERT OR IGNORE INTO thread_turns SELECT * FROM turns;
  INSERT OR IGNORE INTO thread_items SELECT * FROM items;
`);

function saveJson(file: string, body: unknown): void {
  fs.writeFileSync(file + ".tmp", JSON.stringify(body) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
function checkpoint(key: string, value?: any): any {
  if (value !== undefined) db.prepare("INSERT OR REPLACE INTO checkpoints VALUES (?,?)").run(key, JSON.stringify(value));
  const row = db.prepare("SELECT body FROM checkpoints WHERE id=?").get(key);
  return row ? JSON.parse(String(row.body)) : null;
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const intervalMs = Math.max(60_000, Number(process.env.SYNC_INTERVAL_MS ?? 60000));
if (!Number.isFinite(intervalMs)) throw new Error("Invalid SYNC_INTERVAL_MS");
const sshKey = path.join(dataDir, ".ssh", "id_ed25519");
const knownHosts = path.join(dataDir, ".ssh", "known_hosts");
const hostSpecs: Array<{ label: string; target: string }> = JSON.parse(process.env.CLOUD_AUTH_HOSTS ?? "[]");
if (!hostSpecs.length || !hostSpecs.every(h => typeof h.label === "string" &&
  /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+$/.test(h.target))) throw new Error("CLOUD_AUTH_HOSTS must list SSH targets");
if (!process.env.INGESTOR_API_TOKEN) throw new Error("INGESTOR_API_TOKEN is required");

class CloudRpc {
  socket: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  async connect(token: string, accountId: string): Promise<void> {
    // Node's native WebSocket supports headers via its options object (Node 22+).
    const Native = WebSocket as unknown as new (url: string, options: any) => WebSocket;
    const ws = new Native("wss://codex-cloud-backend.chatgpt.com/", {
      protocols: ["codex-app-server", "codex-client.desktop", `openai-bearer.${token}`],
      headers: { "ChatGPT-Account-Id": accountId, "X-OpenAI-Product-Sku": "codex" },
    });
    this.socket = ws;
    ws.addEventListener("message", event => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id != null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(`Cloud ${msg.error.code}: ${String(msg.error.message).slice(0, 160)}`));
            else pending.resolve(msg.result);
          } else if (msg.method) {
            // A passive observer never executes tools or approves another thread.
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: "Read-only collector" } }));
          }
        } else if (msg.method) onNotification(msg.method, msg.params);
      } catch (error) {
        console.error("[cloud] Invalid notification:", error instanceof Error ? error.message : "unknown");
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Cloud connection closed"));
      }
      this.pending.clear();
      if (rpc === this) { rpc = null; status.connected = false; subscriptions.clear(); }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("Cloud handshake timeout")); }, 20_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cloud handshake failed")); }, { once: true });
    });
    await this.call("initialize", { clientInfo: { name: "codex-cloud-ingestor", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: "initialized" }));
  }
  call(method: string, params: any, timeoutMs = 60000): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Cloud unavailable"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cloud request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void { this.socket?.close(); }
}

let rpc: CloudRpc | null = null;
let accessToken = "";
let accountId = "";
let expiresAt = 0;
let busy = false;
let stopping = false;
const subscriptions = new Set<string>();
const models = new Map<string, { model: string; effort?: string }>();
const dirty = new Set<string>();
const status: any = {
  connected: false, authHost: null, authFailures: [], lastSync: null, lastError: null,
  intervalMs, usageCoverage: "Live observed calls only; historical totals are separate snapshots",
};

async function subscribe(thread: CloudThread): Promise<void> {
  if (!rpc || subscriptions.has(thread.id)) return;
  subscriptions.add(thread.id);
  try {
    const result = await rpc.call("thread/resume", { threadId: thread.id, excludeTurns: true }, 15000);
    models.set(thread.id, { model: result.model ?? thread.model ?? "unknown", effort: result.reasoningEffort ?? thread.reasoningEffort });
  } catch (error) { subscriptions.delete(thread.id); throw error; }
}

async function connectFromHosts(): Promise<void> {
  if (rpc && Date.now() < expiresAt - 300000) return;
  rpc?.close();
  rpc = null;
  subscriptions.clear();
  status.connected = false;
  status.authFailures = [];
  for (const host of hostSpecs) {
    if (stopping) return;
    let candidate: CloudRpc | null = null;
    try {
      const { stdout } = await execFileP("ssh", [
        "-i", sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHosts}`, host.target, "cloud-auth",
      ], { timeout: 50_000, maxBuffer: 128 * 1024 });
      const auth = JSON.parse(stdout);
      if (typeof auth.accessToken !== "string") throw new Error("Missing host auth");
      const claims = JSON.parse(Buffer.from(auth.accessToken.split(".")[1], "base64url").toString());
      const account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      const pinned = process.env.CLOUD_ACCOUNT_ID ?? checkpoint("accountId");
      if (!account || (pinned && pinned !== account) || claims.exp * 1000 < Date.now() + 60000) {
        throw new Error("Host account mismatch or expired");
      }
      candidate = new CloudRpc();
      await candidate.connect(auth.accessToken, account);
      await candidate.call("thread/list", { limit: 1 }); // auth alone does not prove cloud access
      rpc = candidate;
      accessToken = auth.accessToken;
      accountId = account;
      expiresAt = claims.exp * 1000;
      checkpoint("accountId", account);
      status.connected = true;
      status.authHost = host.label;
      console.log(`[cloud] Connected using ${host.label}`);
      return;
    } catch {
      candidate?.close();
      // Never log SSH stdout, websocket protocols, or JWTs.
      status.authFailures.push(host.label);
      console.warn(`[cloud] ${host.label} unavailable; trying next host`);
    }
  }
  throw new Error("No auth host available; retrying later");
}

async function pageAll(method: string, params: any): Promise<any[]> {
  const client = rpc;
  if (!client) throw new Error("Cloud unavailable");
  const data: any[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const result = await client.call(method, { ...params, cursor, limit: 100 });
    if (!Array.isArray(result.data)) throw new Error(`Invalid ${method} page`);
    data.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor != null && (typeof cursor !== "string" || seen.has(cursor))) throw new Error("Invalid cloud cursor");
    if (cursor) seen.add(cursor);
  } while (cursor && !stopping);
  if (stopping) throw new Error("Collector stopping");
  return data;
}

function storeRows(thread: CloudThread, rows: CloudRow[]): void {
  const itemInsert = db.prepare("INSERT OR REPLACE INTO thread_items VALUES (?,?,?)");
  const messageInsert = db.prepare("INSERT OR IGNORE INTO messages(id,body) VALUES (?,?)");
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      if (!row.item || typeof row.item.id !== "string" || typeof row.item.type !== "string" || !uuid.test(row.turnId)) {
        throw new Error("Invalid cloud item");
      }
      itemInsert.run(row.item.id, thread.id, JSON.stringify(row));
      const msg = messageFromRow(thread, row, process.env.SENDER_NAME ?? "ET");
      if (msg) messageInsert.run(msg.externalId, JSON.stringify(msg));
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  dirty.add(thread.id);
}

function onNotification(method: string, params: any): void {
  const id = params?.threadId;
  if (!id || !uuid.test(id)) return;
  if (method === "turn/started" && !subscriptions.has(id) && rpc) {
    void rpc.call("thread/read", { threadId: id, includeTurns: false })
      .then(async result => {
        if (!result.thread || result.thread.id !== id) return;
        db.prepare("INSERT OR REPLACE INTO threads VALUES (?,?)").run(id, JSON.stringify(result.thread));
        await subscribe(result.thread);
      }).catch(() => { console.warn("[cloud] New thread subscription deferred to next sync"); });
  }
  if (method === "thread/settings/updated" && params.threadSettings?.model) {
    models.set(id, { model: params.threadSettings.model, effort: params.threadSettings.effort });
  }
  if (method === "model/rerouted" && params.toModel) {
    models.set(id, { ...models.get(id), model: params.toModel });
  }
  if (method === "thread/tokenUsage/updated") {
    const model = models.get(id);
    // Model is established by resume/settings; never infer it from old transcript text.
    if (!model) return;
    const ts = new Date().toISOString();
    const records = usageRecord(params, ts, model.model, model.effort);
    const total = params.tokenUsage.total;
    const usageId = `${id}:${total.totalTokens}`;
    const previous = checkpoint(`total:${id}`);
    const last = params.tokenUsage.last;
    const missing = previous && total.totalTokens >= previous.totalTokens
      ? Math.max(0, total.totalTokens - previous.totalTokens - last.totalTokens) : null;
    const inserted = db.prepare("INSERT OR IGNORE INTO usage VALUES (?,?,?,?)")
      .run(usageId, id, ts, JSON.stringify(records)).changes;
    if (inserted) {
      checkpoint(`total:${id}`, total);
      const coverage = checkpoint(`coverage:${id}`) ?? { firstObservedAt: ts, observedCalls: 0, unbucketedTokens: 0 };
      coverage.observedCalls++;
      coverage.unbucketedTokens += missing ?? Math.max(0, total.totalTokens - last.totalTokens);
      coverage.updatedAt = ts;
      coverage.total = total;
      checkpoint(`coverage:${id}`, coverage);
      dirty.add(id);
    }
  } else if (method === "item/completed") {
    const threadRow = db.prepare("SELECT body FROM threads WHERE id=?").get(id);
    // Persist text promptly; authoritative per-item timestamps arrive on the next scan.
    if (threadRow && params.item) {
      dirty.add(id);
    }
  }
}

function exportThread(id: string): void {
  const entry = db.prepare("SELECT body FROM threads WHERE id=?").get(id);
  if (!entry) return;
  const thread = JSON.parse(String(entry.body)) as CloudThread;
  const rows = db.prepare("SELECT body FROM thread_items WHERE thread_id=?").all(id)
    .map(r => JSON.parse(String(r.body)) as CloudRow)
    .sort((a, b) => (a.startedAtMs ?? a.completedAtMs ?? 0) - (b.startedAtMs ?? b.completedAtMs ?? 0));
  const records = rolloutRows(thread, rows);
  records[0].payload.cloud_usage_coverage = checkpoint(`coverage:${id}`) ?? { firstObservedAt: null, observedCalls: 0 };
  const plan = checkpoint("planUsage");
  const threadPlan = plan?.threads.find((t: any) => t.thread_id === id);
  if (threadPlan) records[0].payload.cloud_plan_usage = {
    weeklyLimitPercent: threadPlan.weekly_limit_percent,
    dataStatus: threadPlan.data_status, dataAsOf: plan.dataAsOf,
  };
  for (const row of db.prepare("SELECT body FROM usage WHERE thread_id=? ORDER BY ts").all(id)) {
    records.push(...JSON.parse(String(row.body)));
  }
  // Usage context/token pairs remain adjacent, including when timestamps are equal.
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const file = path.join(exportDir, `rollout-cloud-${id}.jsonl`);
  fs.writeFileSync(file + ".tmp", records.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o644 });
  fs.renameSync(file + ".tmp", file);
  saveJson(file + ".coverage.json", checkpoint(`coverage:${id}`) ?? { firstObservedAt: null, observedCalls: 0 });
}

async function syncUsagePlan(threads: CloudThread[]): Promise<void> {
  const result: any[] = [];
  let dataAsOf: string | null = null;
  for (let i = 0; i < threads.length; i += 50) {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage/thread_usage/query_v2", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": accountId, "Content-Type": "application/json" },
      body: JSON.stringify({ threads: threads.slice(i, i + 50).map(t => ({ thread_id: t.id })) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Cloud plan usage HTTP ${response.status}`);
    const body = await response.json() as any;
    if (!Array.isArray(body.threads)) throw new Error("Invalid plan usage");
    result.push(...body.threads);
    dataAsOf = body.data_as_of ?? dataAsOf;
  }
  checkpoint("planUsage", { fetchedAt: new Date().toISOString(), dataAsOf, threads: result });
}

async function flushMessages(): Promise<void> {
  for (;;) {
    const pending = db.prepare("SELECT id,body FROM messages WHERE sent=0 LIMIT 200").all();
    if (!pending.length || stopping) break;
    const msgs = pending.map(r => {
      const msg = JSON.parse(String(r.body));
      msg.timestamp = new Date(msg.timestamp);
      return msg;
    });
    const result = await writeMessages(msgs);
    const mark = db.prepare("UPDATE messages SET sent=1 WHERE id=?");
    for (const ok of result.successful) mark.run(ok.message.externalId);
    if (result.failed.length) throw new Error(`${result.failed.length} memory writes failed; retained for retry`);
  }
}

async function sync(): Promise<void> {
  if (busy || stopping) return;
  busy = true;
  status.lastError = null;
  let count = 0;
  try {
    await connectFromHosts();
    if (!rpc) return;
    const all = new Map<string, CloudThread>();
    for (const archived of [false, true]) {
      for (const thread of await pageAll("thread/list", { archived })) {
        if (!uuid.test(thread.id) || !Number.isFinite(thread.createdAt) || !Number.isFinite(thread.updatedAt)) {
          throw new Error("Invalid cloud thread");
        }
        all.set(thread.id, { ...thread, archived });
      }
    }
    const threads = [...all.values()];
    // Subscribe before history collection so new calls are counted during backfill.
    status.subscriptionFailures = [];
    for (const thread of threads.filter(t => !t.archived && t.status?.type === "active")) {
      try { await subscribe(thread); }
      catch { status.subscriptionFailures.push(thread.id); }
    }
    console.log(`[cloud] Found ${threads.length} threads; ${subscriptions.size} live subscriptions`);
    // Publish allowance snapshots and retry queued writes before a long history backfill.
    try { await syncUsagePlan(threads); status.planUsageError = null; }
    catch (error) { status.planUsageError = error instanceof Error ? error.message : "Plan usage unavailable"; }
    await flushMessages();
    status.historyFailures = {};
    for (const thread of threads.sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (stopping) break;
      try {
        db.prepare("INSERT OR REPLACE INTO threads VALUES (?,?)").run(thread.id, JSON.stringify(thread));
        const turns = await pageAll("thread/turns/list", { threadId: thread.id, sortDirection: "asc", itemsView: "notLoaded" });
        for (const turn of turns) {
          if (!uuid.test(turn.id)) throw new Error("Invalid cloud turn");
          const old = db.prepare("SELECT status FROM thread_turns WHERE thread_id=? AND id=?").get(thread.id, turn.id);
          if (old && old.status === turn.status && ["completed", "failed", "interrupted"].includes(turn.status)) continue;
          const rows = await pageAll("thread/items/list", { threadId: thread.id, turnId: turn.id, sortDirection: "asc" });
          storeRows(thread, rows);
          db.prepare("INSERT OR REPLACE INTO thread_turns VALUES (?,?,?)").run(turn.id, thread.id, turn.status);
        }
        dirty.add(thread.id);
        exportThread(thread.id);
        dirty.delete(thread.id);
        count++;
      } catch (error) {
        status.historyFailures[thread.id] = error instanceof Error ? error.message : "History unavailable";
        console.warn(`[cloud] History deferred: ${thread.id}`);
      }
      if (count % 5 === 0) {
        console.log(`[cloud] History ${count}/${threads.length} threads`);
        await flushMessages();
      }
    }
    await flushMessages();
    try { await syncUsagePlan(threads); status.planUsageError = null; }
    catch (error) { status.planUsageError = error instanceof Error ? error.message : "Plan usage unavailable"; }
    for (const thread of threads) exportThread(thread.id);
    status.lastSync = new Date().toISOString();
    checkpoint("lastSync", status.lastSync);
    console.log(`[cloud] Sync finished: ${count} threads, ${Object.keys(status.historyFailures).length} deferred`);
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : "Sync failed";
    console.error(`[cloud] ${status.lastError}`);
  } finally {
    for (const id of dirty) exportThread(id);
    dirty.clear();
    busy = false;
  }
}

const app = express();
app.use(express.json({ limit: "16kb" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", connected: status.connected, syncing: busy }));
app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${process.env.INGESTOR_API_TOKEN}`) { res.status(401).json({ error: "unauthorized" }); return; }
  next();
});
app.get("/api/status", (_req, res) => res.json({
  ...status, syncing: busy, lastSync: status.lastSync ?? checkpoint("lastSync"),
  threads: db.prepare("SELECT count(*) AS n FROM threads").get()?.n,
  messages: db.prepare("SELECT count(*) AS n, sum(sent) AS sent FROM messages").get(),
  observations: db.prepare("SELECT count(*) AS n FROM usage").get()?.n,
}));
app.get("/api/usage", (_req, res) => res.json(checkpoint("planUsage") ?? { threads: [] }));
app.post("/api/sync", (_req, res) => {
  if (busy) { res.status(409).json({ error: "Sync already running" }); return; }
  void sync();
  res.status(202).json({ accepted: true });
});
const server = app.listen(Number(process.env.PORT ?? 3461), "0.0.0.0", () => {
  console.log("[cloud] Collector started");
  void sync();
});
const syncTimer = setInterval(() => { void sync(); }, intervalMs);
const exportTimer = setInterval(() => {
  for (const id of dirty) exportThread(id);
  dirty.clear();
}, 10000);
function shutdown(): void {
  stopping = true;
  clearInterval(syncTimer); clearInterval(exportTimer);
  for (const id of dirty) exportThread(id);
  rpc?.close();
  server.close();
  // SQLite already persists each checkpoint. Bound shutdown during network waits.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
