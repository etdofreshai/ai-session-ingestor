import type { NormalizedMessage } from "./types.js";

export interface CloudThread {
  id: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  status?: { type: string };
  archived?: boolean;
}

export interface CloudRow {
  turnId: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  item: { id: string; type: string; [key: string]: any };
}

export function messageFromRow(thread: CloudThread, row: CloudRow, human: string): NormalizedMessage | null {
  const item = row.item;
  const delegation = item.type === "functionCallOutput" && item.namespace === "cloud_threads" &&
    item.name === "send_message" && typeof item.output === "string" && item.output.startsWith("<codex_delegation>");
  const receipt = item.result?.structuredContent;
  const delivered = item.type === "mcpToolCall" && item.server === "codex_apps" &&
    item.tool === "user_message.send_message" && item.status === "completed" &&
    !item.error && item.result?.isError !== true && row.completedAtMs != null &&
    item.arguments?.channel === "chatgpt" && receipt?.channel === "chatgpt" &&
    receipt.status === "accepted" && typeof receipt.message_id === "string" && receipt.message_id.length > 0;
  if (!["userMessage", "agentMessage"].includes(item.type) && !delegation && !delivered) return null;
  // Streaming assistant text must not be checkpointed before its final contents arrive.
  if (item.type === "agentMessage" && row.completedAtMs == null) return null;
  const content = item.type === "userMessage"
    ? (item.content ?? []).filter((b: any) => b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n\n")
    : delegation ? item.output : delivered ? item.arguments.text : item.text;
  const acceptedAt = delivered ? Date.parse(receipt.created_at) : NaN;
  const ms = Number.isFinite(acceptedAt) ? acceptedAt : row.startedAtMs ?? row.completedAtMs;
  if (typeof content !== "string" || !content.trim() || !Number.isFinite(ms)) return null;
  const role = item.type === "userMessage" ? "human" : delegation ? "delegation" : "assistant";
  return {
    source: "codex",
    externalId: delivered ? `cloud:delivery:${receipt.message_id}` : `cloud:${thread.id}:${item.id}`,
    timestamp: new Date(ms!),
    sender: role === "human" ? human : delivered ? "Dot" : "Codex Cloud",
    recipient: role === "assistant" ? human : "Codex Cloud",
    content,
    metadata: {
      sessionId: thread.id, threadId: thread.id, turnId: row.turnId, itemId: item.id,
      sessionTitle: thread.name ?? null, cwd: thread.cwd ?? null, workspacePath: thread.cwd ?? null,
      hostname: "codex-cloud", hostId: "durable", role, phase: delivered ? "delivery" : item.phase ?? null,
      ...(delivered ? {
        deliveryMessageId: receipt.message_id, deliveryChannel: receipt.channel,
        deliveryRoomId: receipt.room_id ?? null,
        replyToMessageId: item.arguments.destination?.message_id ?? null,
      } : {}),
      // The thread's current model does not establish an old message's model.
      currentThreadModel: thread.model ?? null, model: null,
    },
  };
}

export function rolloutRows(thread: CloudThread, rows: CloudRow[]): any[] {
  const records: any[] = [{
    timestamp: new Date(thread.createdAt * 1000).toISOString(), type: "session_meta",
    payload: { id: thread.id, cwd: thread.cwd, source: "codex-cloud", cloud_title: thread.name },
  }];
  for (const row of rows) {
    const item = row.item;
    const ms = row.startedAtMs ?? row.completedAtMs;
    if (!Number.isFinite(ms)) continue;
    const timestamp = new Date(ms!).toISOString();
    const msg = messageFromRow(thread, row, "ET");
    if (msg) {
      const messageTimestamp = msg.timestamp.toISOString();
      if (msg.metadata.role === "assistant") {
        records.push({ timestamp: messageTimestamp, type: "event_msg", payload: { type: "agent_message", message: msg.content } });
        records.push({ timestamp: messageTimestamp, type: "response_item", payload: {
          type: "message", role: "assistant", id: item.id, phase: msg.metadata.phase,
          content: [{ type: "output_text", text: msg.content }],
        } });
      } else {
        records.push({ timestamp: messageTimestamp, type: "event_msg", payload: { type: "user_message", message: msg.content } });
      }
    }
    if (["commandExecution", "mcpToolCall", "fileChange"].includes(item.type)) {
      const name = item.type === "commandExecution" ? "exec_command"
        : item.type === "fileChange" ? "apply_patch" : `${item.server}.${item.tool}`;
      records.push({ timestamp, type: "response_item", payload: { type: "function_call", name, id: item.id } });
      if (row.completedAtMs != null) records.push({
        timestamp: new Date(row.completedAtMs).toISOString(), type: "response_item",
        payload: { type: "function_call_output", call_id: item.id },
      });
    }
  }
  return records;
}

export function usageRecord(params: any, timestamp: string, model: string, effort?: string): any[] {
  const u = params.tokenUsage?.last;
  const total = params.tokenUsage?.total;
  if (!u || !total || !["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"]
    .every(k => Number.isSafeInteger(u[k]) && u[k] >= 0 && Number.isSafeInteger(total[k]) && total[k] >= 0) ||
    u.cachedInputTokens > u.inputTokens || total.cachedInputTokens > total.inputTokens) {
    throw new Error("Invalid cloud token usage");
  }
  return [
    { timestamp, type: "turn_context", payload: { model, reasoning_effort: effort } },
    { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {
      input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens,
      output_tokens: u.outputTokens, total_tokens: u.totalTokens,
    } } } },
  ];
}
