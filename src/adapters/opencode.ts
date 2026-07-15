import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMessageLimit,
  envPath,
  hostname,
  isAfter,
  userName,
  validDate,
} from "../lib/common.js";
import type { NormalizedMessage, ScanOptions, ScanResult, SourceAdapter } from "../types.js";

type SqlRow = Record<string, unknown>;

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class OpenCodeAdapter implements SourceAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly rootPath: string;
  readonly databasePath: string;

  constructor(
    rootPath = envPath("OPENCODE_DATA_DIR", "~/.local/share/opencode"),
    databasePath = process.env.OPENCODE_DB_PATH
      ? envPath("OPENCODE_DB_PATH", "~/.local/share/opencode/opencode.db")
      : path.join(rootPath, "opencode.db"),
  ) {
    this.rootPath = rootPath;
    this.databasePath = databasePath;
  }

  isAvailable(): boolean {
    return fs.existsSync(this.databasePath);
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const warnings: string[] = [];
    const messages: NormalizedMessage[] = [];
    if (!this.isAvailable()) {
      return { source: this.id, sessions: 0, messages, warnings };
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.databasePath, { readOnly: true });
      const sessions = db.prepare(
        `SELECT id, project_id, workspace_id, parent_id, directory, title, version,
                time_created, time_updated, metadata
           FROM session`,
      ).all() as SqlRow[];
      const sessionMap = new Map(sessions.map((row) => [String(row.id), row]));

      const parts = db.prepare(
        `SELECT id, message_id, time_created, data
           FROM part
          ORDER BY time_created ASC, id ASC`,
      ).all() as SqlRow[];
      const textByMessage = new Map<string, string[]>();
      for (const part of parts) {
        const data = parseObject(part.data);
        if (data.type !== "text" || typeof data.text !== "string" || !data.text.trim()) continue;
        const messageId = String(part.message_id);
        const existing = textByMessage.get(messageId) ?? [];
        existing.push(data.text.trim());
        textByMessage.set(messageId, existing);
      }

      const rows = db.prepare(
        `SELECT id, session_id, time_created, time_updated, data
           FROM message
          ORDER BY time_created ASC, id ASC`,
      ).all() as SqlRow[];
      for (const row of rows) {
        const id = String(row.id);
        const content = (textByMessage.get(id) ?? []).join("\n\n").trim();
        if (!content) continue;
        const data = parseObject(row.data);
        const role = data.role === "user" ? "human" : data.role === "assistant" ? "assistant" : null;
        if (!role) continue;
        const timestamp = validDate(row.time_created);
        if (!timestamp || !isAfter(timestamp, options.sinceMs)) continue;
        const sessionId = String(row.session_id);
        const session = sessionMap.get(sessionId) ?? {};
        const modelObject = data.model && typeof data.model === "object" && !Array.isArray(data.model)
          ? data.model as Record<string, unknown>
          : {};
        const model = stringOrNull(data.modelID) ?? stringOrNull(modelObject.modelID) ?? stringOrNull(session.model);
        const provider = stringOrNull(data.providerID) ?? stringOrNull(modelObject.providerID);
        const human = userName();

        messages.push({
          source: this.id,
          externalId: id,
          timestamp,
          sender: role === "human" ? human : model ?? "OpenCode",
          recipient: role === "human" ? "OpenCode" : human,
          content,
          metadata: {
            sessionId,
            sessionTitle: stringOrNull(session.title),
            directory: stringOrNull(session.directory),
            projectId: stringOrNull(session.project_id),
            workspaceId: stringOrNull(session.workspace_id),
            parentSessionId: stringOrNull(session.parent_id),
            role,
            model,
            provider,
            agent: stringOrNull(data.agent) ?? stringOrNull(session.agent),
            hostname: hostname(),
          },
        });
      }

      return {
        source: this.id,
        sessions: sessions.length,
        messages: applyMessageLimit(messages, options.maxMessages),
        warnings,
      };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return { source: this.id, sessions: 0, messages: [], warnings };
    } finally {
      db?.close();
    }
  }
}
