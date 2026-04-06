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

## Benchmark Prod Log Sources

Benchmark runs auto-collect logs from 3 prod sources into the result JSON (`agents/benchmarks/runs/*.json`):
- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **Fly.io (worker):** Agent execution logs (structlog JSON with `agent_id`) — streamed in real-time via `flyctl logs` during benchmark runs, needs `FLY_API_TOKEN` in `agents/.env`
- **Supabase (research):** Rose API gateway logs (completions, API key validation) — via `SUPABASE_ACCESS_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.
