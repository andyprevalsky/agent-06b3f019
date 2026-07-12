# In-App Benchmark Hub

One account-gated "Benchmarks" tab inside the product (left sidebar, above
Integrations, below Feedback) that replaces the localhost central-hub dashboard:
see every run (live + past), browse/edit the full task catalog, dispatch new
runs, and open any benchmark agent's transcript **in the app** — no localhost
viewer, no per-run Chrome windows, works against deployed prod where benchmarks
run on cloud resources.

## System context

```
 CONTROLLER (Mac / future Fly ctrl)         PROD BACKEND (Render)                WEB APP (Vercel)
 scripts/run-bench-hub-poller ──poll──► GET  /api/benchmarks/run-requests   Sidebar tab "Benchmarks"
   │ claims request (PATCH running)     PATCH /api/benchmarks/run-requests/:id   (ADMIN_USER_IDS-gated)
   │ exports DB catalog → tasks.json    POST /api/benchmarks/runs ◄──────┐    ┌──────────┬───────────┐
   ├ scripts/run-bench <tasks...>          │ live snapshots + final      │    │ Runs pane│ Tasks pane│
   │   (per-bench cloud fleet)             ▼                             │    │ live+past│ catalog + │
   └──uploads report-card + bundle──► R2 (trace-archive bucket,          │    │ open ag. │ stats+edit│
                                          benchmark-hub/ prefix)         │    │ IN-APP   │ +dispatch │
 BenchmarkTask (Postgres, source     GET /api/benchmarks/tasks (DB+stats)│    └──────────┴───────────┘
 of truth for definitions; seeded    PATCH /api/benchmarks/tasks/:name   │    open agent → transcript
 from tasks.json, exported back      GET /api/benchmarks/runs[/:id]      │    rendered by the app itself
 for runners)                        GET .../runs/:id/agents/:agentId ───┘    (bundle-served, RLS-free)
```

## Decisions

- **Task definitions live in a SQL table** (`BenchmarkTask`) — user-directed.
  Seeded from `agents/benchmarks/tasks.json` at backend boot (insert-missing
  only; DB wins afterwards). The poller exports the DB catalog back to the
  repo `tasks.json` before each dispatched run so runners (local.py /
  run_benchmark.py / cloud clones, which ship the controller's dirty diff)
  execute exactly what the DB says. Schema change ships a real migration
  (authored via `prisma migrate diff`, committed).
- **Run storage is R2-only** (reuse trace-archive bucket + client under a
  `benchmark-hub/` key prefix; filesystem fallback under `.context/` for local
  dev). No run tables; index.json + per-run bundle objects.
- **Gating**: reads/edits/dispatch require an authed user in the backend
  admin allowlist (mirrors FE `ADMIN_USER_IDS`, includes Andy + Tamara);
  uploads + poller claims use the internal `X-API-Key` path (`isInternal`).
- **In-app agent view**: benchmark agents live in dead per-bench DBs, so the
  app renders them from the uploaded bundle via
  `GET /api/benchmarks/runs/:id/agents/:agentId` (same `{agent, messages}`
  shape as `GET /api/agents/:id`, plus the full sub-agent `tree` captured by
  the full-tree copy-down). Read-only transcript + expandable fan-out tree.
- **Icons**: task rows and run rows reuse the querybox toggles' lucide icons —
  `Zap` (fast mode) and `Sparkles` (sim) — with hover tooltips.
- **Groups**: the three catalog groups are `rose-bench`, `pipeline-e2e`
  (from `bench`), and `incomplete` (status ≠ ready-ish), matching
  `run_eval_suite.py --list`.
- **Stats**: per-task attempts / pass rate / p50+p95 duration / last attempt,
  computed from `agents/benchmarks/history/task_attempts.jsonl` (committed
  ledger, present in the Render deploy) merged with hub-uploaded run results
  (fresh, post-deploy).

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/benchmarks/tasks` | admin | Full catalog from DB + stats + groups |
| `PATCH /api/benchmarks/tasks/:name` | admin | Validated metadata edit (title, description, tags, timeout_seconds, price_limit_cents, status, bench, expected_tools, min_agent_count, environment.mode) |
| `POST /api/benchmarks/run-requests` | admin | Dispatch: `{task_names[], sim_on?[]}` |
| `GET /api/benchmarks/run-requests` | admin or internal | Queue view (UI + poller) |
| `PATCH /api/benchmarks/run-requests/:id` | internal | Claim / progress / complete (idempotent claim token) |
| `POST /api/benchmarks/runs` | internal | Upload live report-card snapshot or final run bundle → R2 |
| `GET /api/benchmarks/runs` | admin | Run index (live + past, newest first) |
| `GET /api/benchmarks/runs/:id` | admin | Per-task detail (no transcripts) |
| `GET /api/benchmarks/runs/:id/agents/:agentId` | admin | `{agent, messages, tree}` from bundle |

Existing `GET /api/benchmarks` + `GET /api/benchmarks/test-prompts` switch to
DB-first (file fallback) so the querybox picker can't drift from the table.

## Verification (automated)

- Backend: `back-end/src/tests/blackbox/benchmarks.blackbox.ts` covers every
  endpoint — admin gate (403 for non-admin), upload→list→detail→agent-transcript
  round-trip, task PATCH validation (allowlist + bad-field rejection),
  run-request lifecycle (create→claim→progress→complete, double-claim rejected).
- Schema: migration-drift structural test passes with the committed migration.
- Frontend: vitest blackbox for the hub view (MSW: tasks+stats render, tag +
  group filters, select-all-filtered, dispatch POST fired, runs list + agent
  transcript render); structural state-diagram check.
- Agents: pytest for the poller's claim/export/upload unit pieces.
- **Usage validation (the bar for done)**: with the local stack + poller
  running, drive the real UI with Playwright as the user: open Benchmarks tab →
  filter tasks → edit metadata (verify DB row) → select-all-filtered → Run →
  poller executes a real benchmark → run goes live in Runs pane → open agent →
  transcript renders in-app. Screenshots at each step.

## Rollout

1. Schema + migration + seed.
2. Backend store/endpoints + blackbox.
3. Poller + uploader wiring (fleet/local upload final bundles by default when
   `BENCHMARK_HUB_UPLOAD_URL` is set).
4. Frontend tab + hub + editor + dispatch + in-app transcript.
5. Local e2e usage validation (above), then `/deploy` (front-end changes ⇒
   mac-app version bump per repo rule).
