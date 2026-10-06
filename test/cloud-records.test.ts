import { describe, expect, it } from "vitest";
import { messageFromRow, rolloutRows, usageRecord, type CloudRow } from "../src/cloud-records.js";

const thread = { id: "thread", createdAt: 1000, updatedAt: 2000, model: "current-model", name: "Example" };
const row = (type: string, extra: Record<string, unknown> = {}): CloudRow => ({
  turnId: "turn", startedAtMs: 1100000, completedAtMs: 1101000, item: { type, id: "item", ...extra },
});

describe("cloud history", () => {
  it("keeps stable item identity, timestamps, delegation, and excludes tools/unfinished text", () => {
    const r = row("agentMessage", { text: "Answer", phase: "final_answer" });
    const msg = messageFromRow(thread, r, "ET")!;
    expect(msg.externalId).toBe("cloud:thread:item");
    expect(msg.timestamp.getTime()).toBe(1100000);
    expect(msg.metadata.model).toBeNull();
    expect(messageFromRow(thread, { ...r, completedAtMs: null }, "ET")).toBeNull();
    expect(messageFromRow(thread, row("reasoning", { text: "hidden" }), "ET")).toBeNull();
    expect(messageFromRow(thread, row("commandExecution", { text: "tool" }), "ET")).toBeNull();
    expect(messageFromRow(thread, row("functionCallOutput", {
      namespace: "cloud_threads", name: "send_message", output: "<codex_delegation>Continue</codex_delegation>",
    }), "ET")?.metadata.role).toBe("delegation");
    expect(rolloutRows(thread, [r]).filter(r => r.payload.type === "agent_message")).toHaveLength(1);
  });
  it("exports only observed last-call tokens, never puts cumulative history on today's date", () => {
    const last = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 };
    const total = { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000, totalTokens: 11000 };
    const records = usageRecord({ tokenUsage: { last, total } }, "2026-10-06T12:00:00Z", "sol");
    expect(records[1].payload.info.last_token_usage.input_tokens).toBe(100);
    expect(records[0].payload.model).toBe("sol");
    expect(() => usageRecord({ tokenUsage: { last: { ...last, cachedInputTokens: 200 }, total } }, "", "sol")).toThrow();
  });
});
