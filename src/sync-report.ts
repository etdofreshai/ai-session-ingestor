import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { envPath } from './lib/common.js';
import { getApiConfig, request } from './api-writer.js';
import type { SyncResult } from './types.js';

export async function saveAndReportSync(result: SyncResult): Promise<void> {
  const directory = envPath('DATA_DIR','.data');
  await fs.mkdir(directory,{recursive:true});
  const destination = path.join(directory,'last-sync.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary,JSON.stringify(result),{mode:0o600});
  await fs.rename(temporary,destination);
  const config = getApiConfig();
  if (!config || result.dryRun) return;
  for (const source of result.sources) {
    const key = `ai-session:${os.hostname()}:${source.source}`;
    const error = !source.available ? 'Source unavailable on this host' : source.failed > 0
      ? `${source.failed} records failed` : source.warnings.length ? 'Scan completed with warnings' : null;
    const response = await request(`${config.baseUrl}/api/sync-state/${encodeURIComponent(key)}`,'PUT',
      {'Content-Type':'application/json',Authorization:`Bearer ${config.token}`},
      JSON.stringify({source:source.source,last_run_at:result.finishedAt,
        ...(!error ? {last_sync_date:result.finishedAt} : {}),error_message:error,
        metadata:{hostname:os.hostname(),ingestor:'ai-session-ingestor',started_at:result.startedAt,
          finished_at:result.finishedAt,available:source.available,discovered:source.discovered,
          pending:source.pending,inserted:source.inserted,skipped:source.skipped,failed:source.failed,
          warning_count:source.warnings.length,warnings:source.warnings.slice(0,5)}}),15000);
    if (!response.ok) console.error(`[ai-session-ingestor] Could not report ${source.source} freshness: HTTP ${response.status}`);
  }
}

export async function readLastSync(): Promise<SyncResult|null> {
  try { return JSON.parse(await fs.readFile(path.join(envPath('DATA_DIR','.data'),'last-sync.json'),'utf8')); }
  catch { return null; }
}
