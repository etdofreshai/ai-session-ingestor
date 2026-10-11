import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import path from "node:path";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

export function envPath(name: string, fallback: string): string {
  return expandHome(process.env[name]?.trim() || fallback);
}

export function userName(): string {
  return (
    process.env.SENDER_NAME?.trim() ||
    process.env.CLAUDE_CODE_USER?.trim() ||
    os.userInfo().username ||
    "User"
  );
}

export function hostname(): string {
  return os.hostname();
}

export function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function textFromBlocks(
  value: unknown,
  acceptedTypes: ReadonlySet<string> = new Set(["text"]),
): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
    .filter((block) => acceptedTypes.has(String(block.type ?? "")))
    .map((block) => (typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export async function walkFiles(
  root: string,
  accept: (filePath: string) => boolean,
): Promise<string[]> {
  const found: string[] = [];
  if (!fs.existsSync(root)) return found;

  async function visit(dir: string): Promise<void> {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && accept(fullPath)) found.push(fullPath);
    }
  }

  await visit(root);
  return found.sort();
}

export async function* readJsonLines(
  filePath: string,
  onError: (error: unknown) => void = (error) => { throw error; },
): AsyncGenerator<{ lineNumber: number; value: Record<string, unknown> }> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        yield { lineNumber, value: value as Record<string, unknown> };
      }
    }
  } catch (error) { onError(error); }
  finally { lines.close(); stream.destroy(); }
}

export function applyMessageLimit<T>(items: T[], maxMessages?: number): T[] {
  if (maxMessages === undefined) return items;
  return items.slice(0, Math.max(0, maxMessages));
}

export function isAfter(timestamp: Date, sinceMs?: number): boolean {
  return sinceMs === undefined || timestamp.getTime() >= sinceMs;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
