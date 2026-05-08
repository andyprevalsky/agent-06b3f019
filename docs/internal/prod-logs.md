<!-- Extracted from CLAUDE.md by /generate-claude-md. Source of truth for this topic. -->

# Production Logs

## Render (Backend)

Fetch backend prod logs via Render API:
```bash
# Recent logs (last 50)
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=50&direction=backward" \
  | python3 -c "import sys,json; [print(l['message']) for l in json.load(sys.stdin)['logs']]"
```

Env vars are in `back-end/.env`:
- `RENDER_API_KEY` - Render API token
- `RENDER_SERVICE_ID` - `srv-d3jga77diees73cgrvk0`
- `RENDER_OWNER_ID` - `tea-csppgi56l47c73djvpig`

## ClickHouse (Retained Fly.io Worker Logs)

Fetch retained worker logs for an agent:
```bash
cd agents && source .env
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"
```

Recent worker errors:
```bash
cd agents && source .env
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, level, event, message, raw FROM observability.fly_logs WHERE parseDateTimeBestEffortOrNull(timestamp) > now() - INTERVAL 1 HOUR AND (level IN ('error','exception') OR raw ILIKE '%error%' OR raw ILIKE '%traceback%') ORDER BY ingested_at DESC LIMIT 100 FORMAT JSONEachRow"
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
