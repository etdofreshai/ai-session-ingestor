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

const OUTPUT_TEXT = new Set(["output_text"]);

function normalizeWorkspace(value: string | null): string | null {
  if (!value) return null;
  return path.normalize(value.replace(/^\\\\\?\\/, ""));
}

function workspaceSlug(value: string | null): string {
  if (!value) return "unknown";
  return value
    .replace(/^[A-Za-z]:\\?/, (match) => `${match[0]}-`)
    .replace(/[\\/:\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

export class CodexAdapter implements SourceAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly rootPath: string;

  constructor(rootPath = envPath("CODEX_DATA_DIR", "~/.codex")) {
    this.rootPath = rootPath;
  }

  isAvailable(): boolean {
    return ["sessions", "archived_sessions"].some((dir) =>
      fs.existsSync(path.join(this.rootPath, dir)),
    );
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const roots = [path.join(this.rootPath, "sessions"), path.join(this.rootPath, "archived_sessions")];
    const files = (
      await Promise.all(roots.map((root) => walkFiles(root, (file) => file.endsWith(".jsonl"))))
    ).flat();
    const warnings: string[] = [];
    const byExternalId = new Map<string, NormalizedMessage>();

    for (const filePath of files) {
      const entries = await readJsonLines(filePath).catch((error: unknown) => {
        warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      });
      let sessionId = path.basename(filePath, ".jsonl").replace(/^rollout-[^-]+-[^-]+-/, "");
      let cwd: string | null = null;
      let model: string | null = null;

      for (const { lineNumber, value } of entries) {
        const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
          ? value.payload as Record<string, unknown>
          : {};
        if (value.type === "session_meta") {
          if (typeof payload.id === "string" && payload.id) sessionId = payload.id;
          if (typeof payload.cwd === "string") cwd = normalizeWorkspace(payload.cwd);
          continue;
        }
        if (value.type === "turn_context") {
          if (typeof payload.cwd === "string") cwd = normalizeWorkspace(payload.cwd);
          if (typeof payload.model === "string") model = payload.model;
          continue;
        }
        const timestamp = validDate(value.timestamp);
        if (!timestamp || !isAfter(timestamp, options.sinceMs)) continue;

        let role: "human" | "assistant" | null = null;
        let content = "";
        let phase: string | null = null;
        if (value.type === "event_msg" && payload.type === "user_message") {
          role = "human";
          content = typeof payload.message === "string" ? payload.message.trim() : "";
        } else if (
          value.type === "response_item" &&
          payload.type === "message" &&
          payload.role === "assistant"
        ) {
          role = "assistant";
          content = textFromBlocks(payload.content, OUTPUT_TEXT);
          phase = typeof payload.phase === "string" ? payload.phase : null;
        }
        if (!role || !content) continue;

        const human = userName();
        const workspacePath = cwd;
        const message: NormalizedMessage = {
          source: this.id,
          externalId: `${sessionId}:${lineNumber}:${role === "human" ? "user" : "assistant"}`,
          timestamp,
          sender: role === "human" ? human : model ?? "Codex",
          recipient: role === "human" ? "Codex" : human,
          content,
          metadata: {
            sessionId,
            workspace: workspaceSlug(workspacePath),
            workspacePath,
            cwd,
            model,
            phase,
            role,
            hostname: hostname(),
          },
        };
        byExternalId.set(message.externalId, message);
      }
    }

    const messages = [...byExternalId.values()].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    return {
      source: this.id,
      sessions: files.length,
      messages: applyMessageLimit(messages, options.maxMessages),
      warnings,
    };
  }
}
