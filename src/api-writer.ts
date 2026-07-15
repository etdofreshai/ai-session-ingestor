import type {
  BatchWriteResult,
  MessageWriteResult,
  NormalizedMessage,
  WriteAction,
} from "./types.js";

export interface ApiConfig {
  baseUrl: string;
  token: string;
  concurrency: number;
}

export function getApiConfig(): ApiConfig | null {
  const baseUrl = (
    process.env.MEMORY_DATABASE_API_URL ??
    process.env.MEMORY_DB_API_URL ??
    ""
  ).trim().replace(/\/+$/, "");
  const token = (
    process.env.MEMORY_DATABASE_API_WRITE_TOKEN ??
    process.env.MEMORY_DB_API_WRITE_TOKEN ??
    process.env.MEMORY_DATABASE_API_TOKEN ??
    process.env.MEMORY_DB_API_TOKEN ??
    ""
  ).trim();
  if (!baseUrl || !token) return null;
  const parsedConcurrency = Number.parseInt(process.env.WRITE_CONCURRENCY ?? "2", 10);
  return {
    baseUrl,
    token,
    concurrency: Number.isFinite(parsedConcurrency) ? Math.max(1, Math.min(parsedConcurrency, 20)) : 2,
  };
}

export function toApiPayload(message: NormalizedMessage): Record<string, unknown> {
  return {
    source: message.source,
    sender: message.sender,
    recipient: message.recipient,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    external_id: message.externalId,
    metadata: message.metadata,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return error.message;
  const code = (cause as Error & { code?: unknown }).code;
  return `${error.message}: ${typeof code === "string" ? `${code} ` : ""}${cause.message}`;
}

function normalizeAction(value: unknown, status: number): WriteAction {
  if (value === "inserted") return "inserted";
  if (value === "appended") return "appended";
  if (value === "skipped") return "skipped";
  return status === 201 ? "inserted" : "skipped";
}

async function writeOne(
  message: NormalizedMessage,
  config: ApiConfig,
): Promise<MessageWriteResult> {
  const url = `${config.baseUrl}/api/messages?conflict_mode=skip_existing`;
  const maxAttempts = 4;
  const timeoutMs = Math.max(1_000, Number.parseInt(process.env.API_TIMEOUT_MS ?? "30000", 10) || 30_000);
  let lastError = "unknown API error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify(toApiPayload(message)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = describeError(error);
      if (attempt < maxAttempts) {
        await sleep(500 * (2 ** (attempt - 1)));
        continue;
      }
      throw new Error(lastError);
    }

    const bodyText = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed = bodyText ? JSON.parse(bodyText) as unknown : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Error below includes the response excerpt.
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = `Memory Database API ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`;
      if (attempt < maxAttempts) {
        const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "0");
        await sleep(retryAfter > 0 ? retryAfter * 1_000 : 500 * (2 ** (attempt - 1)));
        continue;
      }
      throw new Error(lastError);
    }
    if (!response.ok) {
      throw new Error(
        `Memory Database API ${response.status}: ${bodyText.slice(0, 300) || response.statusText}`,
      );
    }
    if (body.conflict_mode !== "skip_existing") {
      throw new Error("Memory Database API did not honor insert-only conflict mode");
    }
    if (body.action === "overwritten" || body.action === "appended") {
      throw new Error(`Memory Database API unexpectedly ${String(body.action)} an existing message`);
    }
    return { message, action: normalizeAction(body.action, response.status) };
  }

  throw new Error(lastError);
}

async function requireInsertOnlyCapability(config: ApiConfig): Promise<void> {
  const timeoutMs = Math.max(1_000, Number.parseInt(process.env.API_TIMEOUT_MS ?? "30000", 10) || 30_000);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Could not verify Memory Database capabilities: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not verify Memory Database capabilities: HTTP ${response.status}`);
  }
  const body = await response.json() as {
    capabilities?: { message_conflict_modes?: unknown };
  };
  const modes = body.capabilities?.message_conflict_modes;
  if (!Array.isArray(modes) || !modes.includes("skip_existing")) {
    throw new Error(
      "Memory Database API does not advertise skip_existing support; refusing writes to protect existing items",
    );
  }
}

export async function writeMessages(
  messages: NormalizedMessage[],
  config = getApiConfig(),
): Promise<BatchWriteResult> {
  if (!config) {
    throw new Error(
      "Memory Database API is not configured. Set MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_WRITE_TOKEN.",
    );
  }
  const resolvedConfig = config;
  await requireInsertOnlyCapability(resolvedConfig);

  const successful: BatchWriteResult["successful"] = [];
  const failed: BatchWriteResult["failed"] = [];
  if (messages.length === 0) return { successful, failed };

  // Seed each source serially. This lets the API create its source row before
  // concurrent inserts and avoids first-run source-creation lock contention.
  const first = messages[0]!;
  try {
    successful.push(await writeOne(first, resolvedConfig));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failed.push({ message: first, error: reason });
    failed.push(...messages.slice(1).map((message) => ({
      message,
      error: `Batch stopped after the first write failed: ${reason}`,
    })));
    return { successful, failed };
  }

  let nextIndex = 1;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const message = messages[index];
      if (!message) return;
      try {
        successful.push(await writeOne(message, resolvedConfig));
      } catch (error) {
        failed.push({
          message,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(resolvedConfig.concurrency, Math.max(1, messages.length - 1)) }, () => worker()),
  );
  return { successful, failed };
}
