import fs from "node:fs";
import path from "node:path";
import {
  applyMessageLimit,
  envPath,
  hostname,
  isAfter,
  readJsonLines,
  textFromBlocks,
  userName,
  validDate,
  walkFiles,
} from "../lib/common.js";
import type { NormalizedMessage, ScanOptions, ScanResult, SourceAdapter } from "../types.js";

const TEXT = new Set(["text"]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class PiAdapter implements SourceAdapter {
  readonly id = "pi" as const;
  readonly displayName = "Pi";
  readonly rootPath: string;

  constructor(rootPath = envPath("PI_DATA_DIR", "~/.pi/agent")) {
    this.rootPath = rootPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(path.join(this.rootPath, "sessions"));
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const files = await walkFiles(
      path.join(this.rootPath, "sessions"),
      (file) => file.endsWith(".jsonl"),
    );
    const warnings: string[] = [];
    const messages: NormalizedMessage[] = [];

    for (const filePath of files) {
      const entries = await readJsonLines(filePath).catch((error: unknown) => {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      let sessionId = path.basename(filePath, ".jsonl").split("_").at(-1) ?? path.basename(filePath, ".jsonl");
      let cwd: string | null = null;
      let model: string | null = null;
      let provider: string | null = null;

      for (const { lineNumber, value } of entries) {
        if (value.type === "session") {
          sessionId = stringOrNull(value.id) ?? sessionId;
          cwd = stringOrNull(value.cwd);
          continue;
        }
        if (value.type === "model_change") {
          model = stringOrNull(value.modelId) ?? model;
          provider = stringOrNull(value.provider) ?? provider;
          continue;
        }
        if (value.type !== "message") continue;
        const rawMessage = value.message;
        if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
        const message = rawMessage as Record<string, unknown>;
        const role = message.role === "user" ? "human" : message.role === "assistant" ? "assistant" : null;
        if (!role) continue;
        const content = textFromBlocks(message.content, TEXT);
        const timestamp = validDate(value.timestamp) ?? validDate(message.timestamp);
        if (!content || !timestamp || !isAfter(timestamp, options.sinceMs)) continue;
        const entryId = stringOrNull(value.id) ?? String(lineNumber);
        const messageModel = stringOrNull(message.model) ?? model;
        const messageProvider = stringOrNull(message.provider) ?? provider;
        const human = userName();

        messages.push({
          source: this.id,
          externalId: `${sessionId}:${entryId}`,
          timestamp,
          sender: role === "human" ? human : messageModel ?? "Pi",
          recipient: role === "human" ? "Pi" : human,
          content,
          metadata: {
            sessionId,
            cwd,
            role,
            model: messageModel,
            provider: messageProvider,
            usage: message.usage && typeof message.usage === "object" ? message.usage : null,
            stopReason: stringOrNull(message.stopReason),
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
