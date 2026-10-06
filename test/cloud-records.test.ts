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
  it("captures accepted Dot replies as assistant messages, excluding failed sends and other tools", () => {
    const r = row("mcpToolCall", {
      server: "codex_apps", tool: "user_message.send_message", status: "completed", error: null,
      arguments: { channel: "chatgpt", text: "Delivered reply", destination: { message_id: "original" } },
      result: { structuredContent: {
        channel: "chatgpt", status: "accepted", message_id: "Sentinel_reply", room_id: "room",
        created_at: "2026-10-06T12:00:00Z",
      } },
    });
    const msg = messageFromRow(thread, r, "ET")!;
    expect(msg.content).toBe("Delivered reply");
    expect(msg.sender).toBe("Dot");
    expect(msg.externalId).toBe("cloud:delivery:Sentinel_reply");
    expect(messageFromRow({ ...thread, id: "copy" }, { ...r, item: { ...r.item, id: "retry" } }, "ET")?.externalId).toBe(msg.externalId);
    expect(msg.metadata).toMatchObject({ role: "assistant", deliveryMessageId: "Sentinel_reply", replyToMessageId: "original" });
    expect(msg.timestamp.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    const records = rolloutRows(thread, [r]);
    expect(records.filter(r => r.payload.type === "agent_message")).toHaveLength(1);
    expect(records.filter(r => r.payload.type === "user_message")).toHaveLength(0);
    expect(records.filter(r => r.payload.type === "function_call")).toHaveLength(1);
    for (const item of [
      { ...r.item, status: "failed", error: { message: "Failed" } },
      { ...r.item, result: { structuredContent: { ...r.item.result.structuredContent, status: "failed" } } },
      { ...r.item, arguments: { ...r.item.arguments, channel: "sms" } },
      { ...r.item, tool: "cloud_threads.send_message" },
    ]) expect(messageFromRow(thread, { ...r, item }, "ET")).toBeNull();
    expect(messageFromRow(thread, { ...r, completedAtMs: null }, "ET")).toBeNull();
  });
});
