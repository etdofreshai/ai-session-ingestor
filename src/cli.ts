import "dotenv/config";
import { runSync } from "./sync.js";
import { SOURCE_IDS, type SourceId, type SyncOptions } from "./types.js";

function parseSince(value: string): number {
  const relative = /^(\d+(?:\.\d+)?)(m|h|d|w)$/i.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]?.toLowerCase();
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return Date.now() - amount * multiplier;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`Invalid --since value: ${value}`);
  return timestamp;
}

function parseSources(value: string): SourceId[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  for (const source of values) {
    if (!SOURCE_IDS.includes(source as SourceId)) {
      throw new Error(`Unknown source "${source}". Expected one of: ${SOURCE_IDS.join(", ")}`);
    }
  }
  return values as SourceId[];
}

function parseArgs(args: string[]): SyncOptions {
  const options: SyncOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--rescan") options.rescan = true;
    else if (arg === "--source" || arg === "--sources") {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      options.sources = parseSources(value);
    } else if (arg === "--since") {
      const value = args[++index];
      if (!value) throw new Error("--since requires a value");
      options.sinceMs = parseSince(value);
    } else if (arg === "--max-messages") {
      const value = Number.parseInt(args[++index] ?? "", 10);
      if (!Number.isFinite(value) || value < 0) throw new Error("--max-messages requires a non-negative integer");
      options.maxMessages = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npm run sync -- [options]\n\nOptions:\n  --source <ids>       Comma-separated source IDs\n  --since <date|24h>   Only messages at or after this time\n  --max-messages <n>   Limit messages per source\n  --dry-run            Scan without writing or changing state\n  --rescan             Ignore local state (API still uses append-safe conflicts)\n  --help                Show this help`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const result = await runSync(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (result.totals.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
