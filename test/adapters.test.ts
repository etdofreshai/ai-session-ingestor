import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  PiAdapter,
} from "../src/adapters/index.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-ingestor-adapters-"));
  process.env.SENDER_NAME = "Tester";
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
  delete process.env.SENDER_NAME;
});

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("session adapters", () => {
  it("normalizes Claude Code user and assistant text while retaining legacy identities", async () => {
    const root = path.join(tempRoot, "claude");
    await writeJsonl(path.join(root, "projects", "test-project", "session-1.jsonl"), [
      { type: "user", uuid: "u1", sessionId: "session-1", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hello" } },
      { type: "assistant", uuid: "a1", sessionId: "session-1", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }] } },
      { type: "user", uuid: "tool", sessionId: "session-1", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", content: "ignored" }] } },
    ]);

    const result = await new ClaudeCodeAdapter(root).scan();
    expect(result.sessions).toBe(1);
    expect(result.messages.map((message) => message.externalId)).toEqual([
      "session-1:u1",
      "session-1:a1",
    ]);
    expect(result.messages[1]?.content).toBe("hi");
    expect(result.messages[1]?.metadata).toMatchObject({ role: "assistant", model: "claude-test" });
  });

  it("normalizes Codex event and response records with line-stable identities", async () => {
    const root = path.join(tempRoot, "codex");
    await writeJsonl(path.join(root, "sessions", "2026", "rollout.jsonl"), [
      { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: "codex-session", cwd: "/tmp/project" } },
      { type: "turn_context", timestamp: "2026-01-01T00:00:00Z", payload: { cwd: "/tmp/project", model: "gpt-test" } },
      { type: "event_msg", timestamp: "2026-01-01T00:00:01Z", payload: { type: "user_message", message: "build it" } },
      { type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "done" }] } },
    ]);

    const result = await new CodexAdapter(root).scan();
    expect(result.messages.map((message) => message.externalId)).toEqual([
      "codex-session:3:user",
      "codex-session:4:assistant",
    ]);
    expect(result.messages[1]?.metadata).toMatchObject({ model: "gpt-test", phase: "final" });
  });

  it("reads OpenCode message text from its SQLite message and part tables", async () => {
    const root = path.join(tempRoot, "opencode");
    await fs.mkdir(root, { recursive: true });
    const databasePath = path.join(root, "opencode.db");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, metadata TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("ses-1", "proj-1", null, null, "/tmp/project", "Test session", "1", 1, 2, "{}");
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg-1", "ses-1", Date.parse("2026-01-01T00:00:00Z"), 2, JSON.stringify({ role: "user", agent: "build" }));
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg-2", "ses-1", Date.parse("2026-01-01T00:00:01Z"), 2, JSON.stringify({ role: "assistant", modelID: "glm-test", providerID: "test" }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("p1", "msg-1", "ses-1", 1, 1, JSON.stringify({ type: "text", text: "question" }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("p2", "msg-2", "ses-1", 2, 2, JSON.stringify({ type: "reasoning", text: "hidden" }));
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("p3", "msg-2", "ses-1", 3, 3, JSON.stringify({ type: "text", text: "answer" }));
    db.close();

    const result = await new OpenCodeAdapter(root, databasePath).scan();
    expect(result.sessions).toBe(1);
    expect(result.messages.map((message) => [message.externalId, message.content])).toEqual([
      ["msg-1", "question"],
      ["msg-2", "answer"],
    ]);
    expect(result.messages[1]?.metadata).toMatchObject({ sessionTitle: "Test session", model: "glm-test" });
  });

  it("uses Antigravity's generated transcript and skips tool events", async () => {
    const root = path.join(tempRoot, "antigravity");
    await writeJsonl(path.join(root, "brain", "conversation-1", ".system_generated", "logs", "transcript.jsonl"), [
      { type: "USER_INPUT", step_index: 0, created_at: "2026-01-01T00:00:00Z", content: "question", source: "user" },
      { type: "RUN_COMMAND", step_index: 1, created_at: "2026-01-01T00:00:01Z", content: "ignored" },
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: "2026-01-01T00:00:02Z", content: "answer", source: "planner" },
    ]);
    const summaryDb = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    summaryDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, source TEXT, agent_name TEXT)");
    summaryDb.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run("conversation-1", "Test", JSON.stringify(["file:///tmp/project"]), "cli", "Gemini Test");
    summaryDb.close();

    const result = await new AntigravityAdapter(root).scan();
    expect(result.sessions).toBe(1);
    expect(result.messages.map((message) => message.content)).toEqual(["question", "answer"]);
    expect(result.messages[1]?.sender).toBe("Gemini Test");
  });

  it("normalizes Pi model changes and text messages", async () => {
    const root = path.join(tempRoot, "pi");
    await writeJsonl(path.join(root, "sessions", "project", "session.jsonl"), [
      { type: "session", id: "pi-session", cwd: "/tmp/project", timestamp: "2026-01-01T00:00:00Z" },
      { type: "model_change", id: "change", modelId: "pi-model", provider: "test", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", id: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "question" }] } },
      { type: "message", id: "a1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", model: "override-model", provider: "other", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "answer" }] } },
    ]);

    const result = await new PiAdapter(root).scan();
    expect(result.messages.map((message) => message.externalId)).toEqual([
      "pi-session:u1",
      "pi-session:a1",
    ]);
    expect(result.messages[1]?.metadata).toMatchObject({ model: "override-model", provider: "other" });
  });
});
