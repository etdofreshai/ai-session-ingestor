# AI Session Ingestor

One service for ingesting local AI coding sessions into the ET Memory Database.
It replaces the separate Claude Code and Codex ingestors and adds OpenCode,
Antigravity, and Pi.

## Codex cloud service

`npm run start:cloud` runs the separate cloud collector. Dokploy builds it with
`Dockerfile.cloud`. The local ingestor and its existing sources remain separate.

The collector obtains a short-lived access token from a host's own Codex
app-server over SSH, then reads the cloud app-server directly. It tries
`CLOUD_AUTH_HOSTS` in order and retries on the next sync when every host fails.
Refresh tokens stay on their original hosts; no independent ChatGPT login is
needed in the container.

Install `scripts/cloud-auth.py` as `~/.local/bin/codex-cloud-auth.py` on each
host. Give the collector a dedicated SSH key authorized with
`restrict,command="python3 /absolute/home/.local/bin/codex-cloud-auth.py"`.
That key cannot run arbitrary shell commands, forward ports, or allocate a PTY.
Install verified host keys in `/data/.ssh/known_hosts`; the collector requires
strict host-key verification. Its private key is `/data/.ssh/id_ed25519`.

Cloud environment:

```dotenv
CLOUD_AUTH_HOSTS=[{"label":"primary","target":"user@primary"},{"label":"fallback","target":"user@fallback"}]
MEMORY_DATABASE_API_URL=https://your-memory-api.example.com
MEMORY_DATABASE_API_WRITE_TOKEN=...
INGESTOR_API_TOKEN=...
SENDER_NAME=ET
DATA_DIR=/data
CLOUD_EXPORT_DIR=/export/codex
PORT=3461
SYNC_INTERVAL_MS=60000
```

`INGESTOR_API_TOKEN` is required. The memory write token needs only `codex`
scope. An optional `CLOUD_ACCOUNT_ID` pins the expected ChatGPT account;
otherwise the first successful account is pinned in the checkpoint.

Mount separate named volumes at `/data` (SQLite, SSH credentials) and `/export`
(dashboard exports). AI Session Analysis mounts only the export volume and sets
`AI_CLOUD_CODEX_DIR` to its `codex` directory. No credential volume is shared.

Active and archived cloud threads are backfilled with full pagination. User and
completed assistant text, plus incoming cloud delegations, use stable
`cloud:<thread-id>:<item-id>` identities under Memory Database's `codex` source.
Tool results and reasoning stay out of the memory index. SQLite retains the
original cloud items. Completed turns are checkpointed; active turns are
rechecked. Failed memory writes remain pending, and every write uses
`skip_existing`. A running sync is never overlapped.

The service subscribes to unarchived threads without starting turns or sending
messages. Live token notifications are deduplicated by cumulative token total.
Each dated cost record uses only the notification's last model call; cumulative
historical totals and gaps remain separate coverage snapshots. Historical
messages have no inferred model attribution. Weekly allowance estimates are
queried separately and retain the provider's `partial`/`unavailable` status.
Cloud endpoints are private implementation details and may change.

Endpoints:

- `GET /api/health`: liveness and cloud connectivity, no credentials.
- `GET /api/status`: authenticated counts, chosen auth host, failures, last sync.
- `GET /api/usage`: authenticated latest per-thread plan allowance snapshot.
- `POST /api/sync`: authenticated, schedules a sync and returns `202`.

Auth failures try the next host. Connection loss reconnects on the next sync.
SQLite and atomic export files survive redeploys. Shutdown preserves checkpoints.

## Supported sources

| Application | Local store | Memory Database source | Stable identity |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `claudecode` | session ID + message UUID |
| Codex | `~/.codex/sessions/**/*.jsonl` and archived sessions | `codex` | session ID + JSONL line + role |
| OpenCode | `~/.local/share/opencode/opencode.db` | `opencode` | OpenCode message ID |
| Antigravity | `~/.gemini/antigravity-cli/brain/**/transcript.jsonl` | `antigravity` | conversation + step + event + line |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | `pi` | session ID + entry ID |

Only human/user and assistant text is stored. Tool calls, tool results, and
thinking/reasoning blocks are intentionally excluded.

## Safety contract

This ingestor is insert-only:

- Every message has a deterministic `(source, external_id)` identity.
- The writer requires the Memory Database API to advertise
  `skip_existing` support before sending any message.
- Every POST uses `conflict_mode=skip_existing`.
- Existing identities are returned unchanged even when incoming content or
  metadata differs. No overwrite and no SCD history append occurs.
- The client rejects any `appended` or `overwritten` API response.
- A durable `.data/ingest-state.json` checkpoint avoids unnecessary repeat
  requests. Only confirmed inserts/skips are checkpointed.
- API failures are retried with timeouts; failed messages remain pending.

The required API capability is implemented by the companion changes in the
sibling `memory-database-api` checkout. Until that API version is deployed,
production writes fail closed before the first POST.

## Setup

Requires Node.js 22.5 or newer.

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Configure these values in `.env`:

```dotenv
MEMORY_DATABASE_API_URL=https://your-memory-api.example.com
MEMORY_DATABASE_API_WRITE_TOKEN=...
SENDER_NAME=ET
```

The write token should be limited to these sources:

```text
claudecode,codex,opencode,antigravity,pi
```

All source paths can be overridden; see [.env.example](.env.example).

## CLI

Read-only scan of every source:

```bash
npm run sync -- --dry-run
```

Useful bounded scans:

```bash
npm run sync -- --dry-run --source pi
npm run sync -- --dry-run --source opencode,antigravity --since 7d
npm run sync -- --dry-run --source codex --max-messages 100
npm run sync -- --baseline
```

Use `--baseline` during migration from older ingestors. It records all messages
currently present on the host as seen without sending them to Memory Database;
subsequent automatic syncs send only newly discovered messages.

Write pending messages:

```bash
npm run sync -- --source pi
npm run sync -- --source opencode,antigravity --since 7d
```

`--rescan` ignores local state, but the API still skips every existing identity.
It is intended for verifying server-side idempotency after deployment.

## HTTP service

```bash
npm run build
npm start
```

The service binds to `0.0.0.0:3460` by default and exposes:

- `GET /api/health` — source availability and Memory Database configuration
- `GET /api/status` — checkpoint counts and the previous sync result
- `POST /api/sync` — run a sync with JSON options

Example:

```bash
curl -X POST http://localhost:3460/api/sync \
  -H 'Content-Type: application/json' \
  --data '{"sources":["pi"],"dryRun":true,"maxMessages":10}'
```

Set `INGESTOR_API_TOKEN` to require a Bearer token on `POST /api/sync`.
Set `AUTO_SYNC=true` to sync immediately at startup and then every
`SYNC_INTERVAL_MS` (15 minutes by default).

## Migration from the separate ingestors

1. Deploy the Memory Database API `skip_existing` capability.
2. Give this app a write token restricted to the five source names above.
3. Run a complete dry run and review counts.
4. Backfill Pi, then OpenCode and Antigravity in bounded date windows.
5. Run Claude Code and Codex with `--since` set to the last successful old
   ingestor run. Their source names and external IDs remain compatible.
6. Start this service with `AUTO_SYNC=true`.
7. After one successful scheduled cycle, stop the old Claude and Codex
   ingestors. Do not run both indefinitely.

For a large historical import, work in date windows rather than issuing the
entire backlog in one run. The local full-scan count on the development host is
over 240,000 messages.

## Containers and PM2

The repository includes a production `Dockerfile` and
`ecosystem.config.cjs`. Mount the host session directories read-only and mount
a persistent volume at `/app/.data` for the checkpoint:

```text
~/.claude                         -> /sources/claude:ro
~/.codex                          -> /sources/codex:ro
~/.local/share/opencode           -> /sources/opencode:ro
~/.gemini/antigravity-cli         -> /sources/antigravity:ro
~/.pi/agent                       -> /sources/pi:ro
ai-session-ingestor-state volume  -> /app/.data
```

Point the corresponding `*_DATA_DIR` environment variables at those mounted
paths.
