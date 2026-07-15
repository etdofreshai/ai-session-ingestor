import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { writeMessages, type ApiConfig } from "../src/api-writer.js";
import type { NormalizedMessage } from "../src/types.js";

let server: http.Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

function sampleMessage(id: string): NormalizedMessage {
  return {
    source: "pi",
    externalId: id,
    timestamp: new Date("2026-01-01T00:00:00Z"),
    sender: "Tester",
    recipient: "Pi",
    content: "hello",
    metadata: { sessionId: "session", role: "human" },
  };
}

describe("Memory Database writer", () => {
  it("always uses append-safe conflicts and recognizes inserts and duplicate skips", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let call = 0;
    server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/api/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          status: "ok",
          capabilities: { message_conflict_modes: ["skip_existing", "skip_or_append"] },
        }));
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          url: request.url ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        });
        call += 1;
        response.writeHead(call === 1 ? 201 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          action: call === 1 ? "inserted" : "skipped",
          conflict_mode: "skip_existing",
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const config: ApiConfig = { baseUrl: `http://127.0.0.1:${address.port}`, token: "test", concurrency: 1 };

    const result = await writeMessages([sampleMessage("one"), sampleMessage("two")], config);
    expect(result.successful.map((entry) => entry.action)).toEqual(["inserted", "skipped"]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url === "/api/messages?conflict_mode=skip_existing")).toBe(true);
    expect(requests.map((request) => request.body.external_id)).toEqual(["one", "two"]);
  });

  it("refuses all writes when the API lacks insert-only support", async () => {
    let postCount = 0;
    server = http.createServer((request, response) => {
      if (request.method === "POST") postCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const config: ApiConfig = { baseUrl: `http://127.0.0.1:${address.port}`, token: "test", concurrency: 1 };

    await expect(writeMessages([sampleMessage("one")], config)).rejects.toThrow(/skip_existing/);
    expect(postCount).toBe(0);
  });
});
