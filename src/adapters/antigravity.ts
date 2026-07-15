import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMessageLimit,
  envPath,
  hostname,
  isAfter,
  readJsonLines,
  userName,
  validDate,
  walkFiles,
} from "../lib/common.js";
import type { NormalizedMessage, ScanOptions, ScanResult, SourceAdapter } from "../types.js";

interface ConversationSummary {
  title: string | null;
  workspaceUris: unknown;
  source: string | null;
  agentName: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseWorkspaceUris(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value || null;
  }
}

export class AntigravityAdapter implements SourceAdapter {
  readonly id = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly rootPath: string;

  constructor(rootPath = envPath("ANTIGRAVITY_DATA_DIR", "~/.gemini/antigravity-cli")) {
    this.rootPath = rootPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(path.join(this.rootPath, "brain"));
  }

  private loadSummaries(warnings: string[]): Map<string, ConversationSummary> {
    const result = new Map<string, ConversationSummary>();
    const databasePath = path.join(this.rootPath, "conversation_summaries.db");
    if (!fs.existsSync(databasePath)) return result;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      const rows = db.prepare(
        `SELECT conversation_id, title, workspace_uris, source, agent_name
           FROM conversation_summaries`,
      ).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        result.set(String(row.conversation_id), {
          title: stringOrNull(row.title),
          workspaceUris: parseWorkspaceUris(row.workspace_uris),
          source: stringOrNull(row.source),
          agentName: stringOrNull(row.agent_name),
        });
      }
    } catch (error) {
      warnings.push(`conversation summaries: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db?.close();
    }
    return result;
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const warnings: string[] = [];
    const summaries = this.loadSummaries(warnings);
    const brainRoot = path.join(this.rootPath, "brain");
    const files = await walkFiles(
      brainRoot,
      (file) => file.endsWith(`${path.sep}logs${path.sep}transcript.jsonl`),
    );
    const messages: NormalizedMessage[] = [];

    for (const filePath of files) {
      const relative = path.relative(brainRoot, filePath).split(path.sep);
      const conversationId = relative[0];
      if (!conversationId) continue;
      const summary = summaries.get(conversationId);
      const entries = await readJsonLines(filePath).catch((error: unknown) => {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });

      for (const { lineNumber, value } of entries) {
        const type = value.type;
        const role = type === "USER_INPUT" ? "human" : type === "PLANNER_RESPONSE" ? "assistant" : null;
        if (!role || typeof value.content !== "string" || !value.content.trim()) continue;
        const timestamp = validDate(value.created_at);
        if (!timestamp || !isAfter(timestamp, options.sinceMs)) continue;
        const human = userName();
        const stepIndex = typeof value.step_index === "number" ? value.step_index : lineNumber;
        messages.push({
          source: this.id,
          externalId: `${conversationId}:${stepIndex}:${type}:${lineNumber}`,
          timestamp,
          sender: role === "human" ? human : summary?.agentName ?? "Antigravity",
          recipient: role === "human" ? "Antigravity" : human,
          content: value.content.trim(),
          metadata: {
            sessionId: conversationId,
            sessionTitle: summary?.title ?? null,
            workspaceUris: summary?.workspaceUris ?? null,
            transcriptSource: stringOrNull(value.source) ?? summary?.source ?? null,
            stepIndex,
            eventType: type,
            role,
            hostname: hostname(),
          },
        });
      }
    }

    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return {
      source: this.id,
      sessions: files.length,
      messages: applyMessageLimit(messages, options.maxMessages),
      warnings,
    };
  }
}
