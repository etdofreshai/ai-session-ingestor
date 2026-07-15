import { createAdapters } from "./adapters/index.js";
import { writeMessages } from "./api-writer.js";
import { StateStore } from "./state-store.js";
import type {
  NormalizedMessage,
  SourceAdapter,
  SourceSyncResult,
  SyncOptions,
  SyncResult,
} from "./types.js";

export interface SyncDependencies {
  adapters?: SourceAdapter[];
  state?: StateStore;
  writer?: typeof writeMessages;
}

function uniqueMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const byIdentity = new Map<string, NormalizedMessage>();
  for (const message of messages) {
    byIdentity.set(`${message.source}\0${message.externalId}`, message);
  }
  return [...byIdentity.values()];
}

function emptyResult(source: SourceAdapter, available: boolean): SourceSyncResult {
  return {
    source: source.id,
    available,
    sessions: 0,
    discovered: 0,
    pending: 0,
    baselined: 0,
    inserted: 0,
    skipped: 0,
    appended: 0,
    failed: 0,
    warnings: [],
  };
}

export async function runSync(
  options: SyncOptions = {},
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const adapters = dependencies.adapters ?? createAdapters();
  const state = dependencies.state ?? new StateStore();
  const writer = dependencies.writer ?? writeMessages;
  await state.load();

  const selected = options.sources?.length
    ? adapters.filter((adapter) => options.sources?.includes(adapter.id))
    : adapters;
  const sourceResults: SourceSyncResult[] = [];

  for (const adapter of selected) {
    const available = adapter.isAvailable();
    const result = emptyResult(adapter, available);
    if (!available) {
      result.warnings.push(`Source directory is unavailable: ${adapter.rootPath}`);
      sourceResults.push(result);
      continue;
    }

    try {
      const scan = await adapter.scan({
        sinceMs: options.sinceMs,
        maxMessages: options.maxMessages,
      });
      const discovered = uniqueMessages(scan.messages);
      const pending = options.rescan
        ? discovered
        : discovered.filter((message) => !state.has(message.source, message.externalId));
      result.sessions = scan.sessions;
      result.discovered = discovered.length;
      result.warnings.push(...scan.warnings);

      if (options.baseline) {
        if (options.dryRun) {
          result.baselined = pending.length;
        } else {
          for (const message of pending) {
            state.mark(message.source, message.externalId);
          }
          result.baselined = pending.length;
          await state.save();
        }
        sourceResults.push(result);
        continue;
      }

      result.pending = pending.length;

      if (!options.dryRun && pending.length > 0) {
        const writes = await writer(pending);
        for (const success of writes.successful) {
          result[success.action] += 1;
          state.mark(success.message.source, success.message.externalId);
        }
        result.failed = writes.failed.length;
        result.warnings.push(
          ...writes.failed.slice(0, 20).map((failure) =>
            `${failure.message.externalId}: ${failure.error}`,
          ),
        );
        await state.save();
      }
    } catch (error) {
      result.failed += 1;
      result.warnings.push(error instanceof Error ? error.message : String(error));
    }
    sourceResults.push(result);
  }

  const totals = sourceResults.reduce(
    (sum, result) => ({
      sessions: sum.sessions + result.sessions,
      discovered: sum.discovered + result.discovered,
      pending: sum.pending + result.pending,
      baselined: sum.baselined + result.baselined,
      inserted: sum.inserted + result.inserted,
      skipped: sum.skipped + result.skipped,
      appended: sum.appended + result.appended,
      failed: sum.failed + result.failed,
    }),
    { sessions: 0, discovered: 0, pending: 0, baselined: 0, inserted: 0, skipped: 0, appended: 0, failed: 0 },
  );

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    sources: sourceResults,
    totals,
  };
}
