<!-- Extracted from CLAUDE.md by /generate-claude-md. Source of truth for this topic. -->

# Production Logs

Never `source` an `.env` file (`agents/.env` is not shell-safe and leaks a token fragment); the commands below load it with python-dotenv's CLI from the agents venv.

## Render (Backend)

Fetch backend prod logs via Render API:
```bash
# Recent logs (last 50)
cd back-end && ../agents/venv/bin/dotenv -f .env run -- sh -c 'curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=50&direction=backward"' \
  | python3 -c "import sys,json; [print(l['message']) for l in json.load(sys.stdin)['logs']]"
```

Env vars are in `back-end/.env`:
- `RENDER_API_KEY` - Render API token
- `RENDER_SERVICE_ID` - `srv-d3jga77diees73cgrvk0`
- `RENDER_OWNER_ID` - `tea-csppgi56l47c73djvpig`

## Prod health / latency (golden signals)

"Is the backend slow right now?" is one call: `cd back-end && npx tsx scripts/prod-health.ts`. It reads `RENDER_*` from `back-end/.env`, pulls Render request logs for a window (backing off on the log API's 429s) and prints:

- **Latency:** per-endpoint p50/p90/p99/max, with routes templatized so `/api/agents/<uuid>` aggregates.
- **Traffic** (request counts) and **errors** (4xx/5xx per route and total).
- **Saturation:** slowest Prisma operations, an `EMAXCONN`/max-connection banner, and deploy/instance state.
- Each endpoint's p90 is compared with a rolling baseline in `scripts/.prod-health-history.jsonl` (gitignored, appended every run), so `▲ +180%` marks a real regression.

Flags: `--window 2h` (default 30m), `--top 30`, `--json`, `--history` (show the baseline), `--no-record` (don't append this run).

A p99 spike with the pool-saturation banner usually means a Render deploy cutover: old and new instances' Prisma pools exceed the Supabase pooler client cap, queries wait out Prisma's ~30 s pool-acquisition timeout, then fail with `EMAXCONN`.

- Guard (since 2026-07): `back-end/src/providers/database.ts` derives `connection_limit` from the pooler budget `POOLER_MAX_CLIENT_CONN` (1000 on Render for the XL tier; code default 400) minus the DEMO cache pool `DEMO_CACHE_DB_POOL` (legacy `FAST_CACHE_DB_POOL`); `back-end/src/tests/structural/db-pool-invariant.test.ts` cements it.
- Database: Supabase XL (4 dedicated cores, 16 GB, `max_connections=240`, Supavisor `pool_size=60`).

## ClickHouse (Retained Fly.io Worker Logs)

Fetch retained worker logs for an agent:
```bash
cd agents && venv/bin/dotenv -f .env run -- sh -c 'curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" --data-urlencode query@-' <<'SQL'
SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow
SQL
```

Recent worker errors:
```bash
cd agents && venv/bin/dotenv -f .env run -- sh -c 'curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" --data-urlencode query@-' <<'SQL'
SELECT timestamp, level, event, message, raw FROM observability.fly_logs WHERE parseDateTimeBestEffortOrNull(timestamp) > now() - INTERVAL 1 HOUR AND (level IN ('error','exception') OR raw ILIKE '%error%' OR raw ILIKE '%traceback%') ORDER BY ingested_at DESC LIMIT 100 FORMAT JSONEachRow
SQL
```

Env vars are in `agents/.env`:
- `CLICKHOUSE_ENDPOINT` - ClickHouse Cloud HTTP endpoint
- `CLICKHOUSE_USER` - ClickHouse user
- `CLICKHOUSE_PASSWORD` - ClickHouse password

## Benchmark Prod Log Sources

Benchmark runs auto-collect logs from retained ClickHouse rows and live prod sources into the result JSON (`agents/benchmarks/runs/*.json`):
- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **ClickHouse (retained Fly.io worker):** Agent execution logs from `observability.fly_logs`, retained 7 days — via `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` in `agents/.env`
- **Fly.io (live worker stream):** Live agent execution logs during benchmark runs — via `FLY_API_TOKEN` in `agents/.env`
- **Supabase (research):** Rose API gateway logs (completions, API key validation) — via `SUPABASE_ACCESS_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.
