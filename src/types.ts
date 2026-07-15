export const SOURCE_IDS = [
  "claudecode",
  "codex",
  "opencode",
  "antigravity",
  "pi",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];
export type MessageRole = "human" | "assistant";

export interface NormalizedMessage {
  source: SourceId;
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ScanOptions {
  sinceMs?: number;
  maxMessages?: number;
}

export interface ScanResult {
  source: SourceId;
  sessions: number;
  messages: NormalizedMessage[];
  warnings: string[];
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly displayName: string;
  readonly rootPath: string;
  isAvailable(): boolean;
  scan(options?: ScanOptions): Promise<ScanResult>;
}

export type WriteAction = "inserted" | "skipped" | "appended";

export interface MessageWriteResult {
  message: NormalizedMessage;
  action: WriteAction;
}

export interface WriteFailure {
  message: NormalizedMessage;
  error: string;
}

export interface BatchWriteResult {
  successful: MessageWriteResult[];
  failed: WriteFailure[];
}

export interface SyncOptions extends ScanOptions {
  sources?: SourceId[];
  dryRun?: boolean;
  rescan?: boolean;
  baseline?: boolean;
}

export interface SourceSyncResult {
  source: SourceId;
  available: boolean;
  sessions: number;
  discovered: number;
  pending: number;
  baselined: number;
  inserted: number;
  skipped: number;
  appended: number;
  failed: number;
  warnings: string[];
}

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  sources: SourceSyncResult[];
  totals: Omit<SourceSyncResult, "source" | "available" | "warnings">;
}
