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

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly id = "claudecode" as const;
  readonly displayName = "Claude Code";
  readonly rootPath: string;

  constructor(rootPath = envPath("CLAUDE_DATA_DIR", "~/.claude")) {
    this.rootPath = rootPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(path.join(this.rootPath, "projects"));
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const projectsRoot = path.join(this.rootPath, "projects");
    const files = await walkFiles(projectsRoot, (file) => file.endsWith(".jsonl"));
    const warnings: string[] = [];
    const messages: NormalizedMessage[] = [];

    for (const filePath of files) {
      const relative = path.relative(projectsRoot, filePath).split(path.sep);
      const project = relative[0] || "unknown";
      const fallbackSessionId = path.basename(filePath, ".jsonl");
      const entries = await readJsonLines(filePath).catch((error: unknown) => {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });

      for (const { value } of entries) {
        const type = value.type;
        if (type !== "user" && type !== "assistant") continue;
        const rawMessage = value.message;
        if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
        const message = rawMessage as Record<string, unknown>;
        const uuid = typeof value.uuid === "string" ? value.uuid : null;
        const sessionId =
          (typeof value.sessionId === "string" && value.sessionId) || fallbackSessionId;
        const timestamp = validDate(value.timestamp);
        if (!uuid || !timestamp || !isAfter(timestamp, options.sinceMs)) continue;

        let content = "";
        let role: "human" | "assistant";
        let model: string | null = null;
        if (type === "user" && message.role === "user") {
          if (Array.isArray(message.content)) {
            const hasToolResult = message.content.some(
              (block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result",
            );
            if (hasToolResult) continue;
          }
          content = textFromBlocks(message.content, TEXT);
          role = "human";
        } else if (type === "assistant" && message.role === "assistant") {
          content = textFromBlocks(message.content, TEXT);
          role = "assistant";
          model = typeof message.model === "string" ? message.model : null;
        } else {
          continue;
        }
        if (!content) continue;

        const human = userName();
        messages.push({
          source: this.id,
          externalId: `${sessionId}:${uuid}`,
          timestamp,
          sender: role === "human" ? human : "Claude",
          recipient: role === "human" ? "Claude" : human,
          content,
          metadata: {
            sessionId,
            project,
            model,
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
