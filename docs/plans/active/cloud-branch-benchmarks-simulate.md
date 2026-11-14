# Cloud Branch Benchmarks (Simulate Mode)

Run any benchmark from `agents/benchmarks/tasks.json` against the **current branch's
code**, in **simulate mode**, served on the **prod (cloud) stack** rather than local
machine resources — so the WMH and the agent tree get strong concurrency — with a
standardized live report card and a finished, trustworthy validation path.

## Why

- A benchmark can be one huge job — e.g. "make me US president" is a single **shared world**
  populated by **10k agents created through recursive `spawn_general_purpose` calls, wired into
  one tree**. Local machine resources can't serve that concurrently.
- Simulate mode is the enabler: agent loops, LLM calls, and **orchestration (`spawn_*`) stay real**;
  only **environment boundaries** (web / browser / phone / payments / SMS / provider req-resp) are
  intercepted and answered by the World Model Harness (WMH). So a run fires **zero real third-party
  side effects** — no Twilio/Stripe/Steel/Vapi secrets, deterministic, no purchases.

## What already exists (grounded in code — reuse as-is)

- **Boundary interception:** `WorldModelToolExecutionAdapter` + `CanonicalAction` +
  `is_world_model_environment_boundary()` (`agents/helpers/world_model_runtime.py`) map every Rose
  tool call at an environment boundary → a WMH `step`. Done.
- **World build pipeline:** `update_world_model_for_simulation()` →
  `build_world_model_from_otel_jsonl()` → vendored `wmh.engine.build` (GEPA); artifact at
  `.context/world-model/models/rose-archive/`; index via vendored `EmbeddingRetriever`/
  `HashingEmbedder`; delta-updated from the **R2 trace archive** (`TRACE_ARCHIVE_BACKEND=r2`).
  Done. (Corpus is sourced from R2, so it needs no checkout — critical, since `.context/` is
  gitignored.)
- **Client:** `WMHHttpClient` (`world_model_harness.py`, `world_model_runtime.py`) talks to a WMH
  daemon at `WMH_BASE_URL`. Done.
- **The tree already shares ONE world session.** `WMH_SESSION_ID` is set once per run and
  `build_spawn_payload()` does **not** override it — every spawned sub-agent inherits it via the
  environment. So the whole tree points at **one WMH session** = one shared `history` + one shared
  `scratchpad` + one shared retriever enrichment. **The "consistent bubble across all agents" is
  already how it's wired.** No custom retriever, no shared-state store, no WMH fork required.

## The actual gap (narrow)

1. **Nothing serves the WMH.** `run.sh` / `run-bench` / `local.py` never start a server;
   `WMH_BASE_URL` is only read from env or set from `--world-model-url` (`run_benchmark.py:468`).
   A simulate run today requires a manually-started `wmh serve`.
2. **Serving runs on local resources**, so concurrency is weak.
3. **No standardized live progress** for a running benchmark.
4. **Simulate coverage/validation across the catalog is unfinished** — we can't yet say "any task,
   `--simulate`, and we're good."

## Non-goals (explicit)

- **Do NOT rewrite how the WMH builds context / manages the shared session's growing history.** The
  single-shared-session design has known scale limits (unbounded `history` per step, in-place
  mutation under concurrency, in-RAM O(n²) retriever `add`). **It's OK that it doesn't scale
  forever right now** — that is a founder-track conversation with the WMH authors, not this plan.
- No new ephemeral prod-like environments beyond what the isolation layer + a served WMH give us.
- No changes to task definitions, prompts, pass criteria, or timeouts (CLAUDE.md rule 25).

## Architecture

Two clean halves; only serving is new.

```
run-bench (controller: local CLI or CI)                 [emits report card q60s]
  ├─ builds/points at branch WMH model (R2 corpus)
  ├─ enqueues benchmark → prod-parity agent fleet
  ├─ polls run + prints standardized report card
  └─ tears everything down + records infra/cost metadata

Cloud (prod) stack — strong concurrency
  ├─ Agent tree: real recursive spawn_general_purpose = real Temporal child-workflow
  │   tree on the Fly worker fleet, per-run queue navi-agent-tasks-<ws>,
  │   scaled by the SAME prod autoscaler (poll_queue_metrics / Fly Machines API)
  └─ WMH serving daemon (NEW): hosts the ONE shared session for the run;
      every leaf boundary call → WMHHttpClient.step against it
```

- **Agent side = existing infra.** 10k agents = 10k workflows in a real spawn tree; Temporal owns
  parent/child + causal order; the **prod autoscaler scales the fleet to the tree's fan-out**.
  Reusing the *identical* autoscaler means an autoscaling bug surfaced by a branch bench is a prod
  bug — the fix fixes prod too. The bench doubles as a controlled load test of the autoscaler.
- **World side = one served WMH** per run, one shared session (already wired). Served in the cloud
  stack for concurrency, not on the laptop.

## Workstreams

### 1. Serve the WMH in the cloud stack (the core gap)
- Add a served WMH tier (containerized `wmh serve` / `create_app` over the branch-built model).
  Runs in the cloud stack, not local. Health-checked; `WMH_BASE_URL` published to the run.
- Branch-buildable: the model builds from the R2 corpus at run start
  (`update_world_model_for_simulation()`), so it reflects the branch under test.
- Lifecycle owned by the controller: build/point → health-wait → run → teardown.
- **Scope guard:** serve the WMH *as the vendored package serves it*. Do not re-engineer its
  session/context handling (non-goal above).

### 2. Route benchmark runs to the cloud stack
- `run-bench` / `local.py` become a **controller** that drives the cloud stack instead of hosting
  agents locally: deploy/point branch agents image → per-run Temporal queue → served WMH → poll.
- Everything namespaced by `CONDUCTOR_WORKSPACE_NAME=ci-<branch>-<run>` (DB, queue, ports, WMH),
  so concurrent branch runs never collide.
- Real external deps that simulate mode keeps: LLM creds (claudeAuth / OpenRouter), Temporal Cloud,
  R2, Supabase, per-run DB. No payment/SMS/browser/phone secrets.

### 3. Standardized live report card (local-driven runs), emitted every 60s
Emitted by the controller to stdout **and** `.context/benchmarks/<run-id>/report-card.json`,
refreshed every 60s while a run is in flight (and once final). Schema:

```jsonc
{
  "run_id": "…", "elapsed_s": 615, "world_model_mode": "simulate",
  "tasks":   { "total": 40, "running": 5, "completed": 33, "queued": 2 },
  "results": { "passed": 30, "failed": 3, "transient": 1, "success_rate": 0.909 },
  "cost":    { "agents_llm_usd": 4.12, "wmh_grounding_usd": 1.87, "total_usd": 5.99,
               "fast_cache_hit_rate": 0.71 },
  "infra":   { "fleet_machines": 12, "peak_machines": 18, "wmh_served": true,
               "queue_depth": 2 },
  "per_task":[ { "name": "chat-mode", "status": "passed", "duration_s": 74,
                 "cost_usd": 0.09, "agent_url": "http://…/?agent-id=…" } ]
}
```
Wire into the existing poll loop in `local.py`; reuse cost/cache aggregation from
`run_benchmark.py --compare` and the attempts ledger.

### 4. Finish simulate validation (any task, `--simulate`, good)
- Ensure every `status: "ready"` task in `tasks.json` runs under `--simulate` end to end through the
  served WMH: boundary tools intercepted, run completes, evaluators score.
- Fill simulate gaps per task (missing seed_state, boundary tools not mapped in `CanonicalAction`,
  etc.). No task-definition changes — only simulate plumbing.
- `run_eval_suite.py --simulate` becomes the one command that runs the whole `rose-bench` axis in
  simulate against the served WMH.

### 5. Teardown + infra/cost metadata (first-class)
- **Teardown as a subsystem:** every resource tagged with `run_id` (Fly machines, per-run DB, queue,
  served WMH). Controller `finally` → fleet to 0 / machines destroyed, DB dropped, queue deleted,
  WMH stopped. A **crash-safe reaper** (scheduled, run_id-scoped, TTL) destroys orphans from a dead
  controller. **Budget kill-switch:** cost/wall-time ceiling → auto-teardown. `teardown_verified:
  true`, `leaked_resources: []` recorded post-run.
- **Post-run metadata block** in the result JSON: `machines` (total_spawned, peak, machine_seconds),
  `autoscaler` timeline, `wmh` (served, grounding tokens/cost), `llm_agents` (tokens/cost, cache
  hit rate), `cost_usd` breakdown + total, `teardown`.

## Verification

Automated where possible; the scale ramp is approval-gated by the user per their request, but **each
rung is a scripted check that emits the report card + metadata block** — approval is gated on a
readable green report, not eyeballing logs.

**Oracle:** run the target set locally first, partition into `PASS_LOCAL` / `FAIL_LOCAL`. The cloud
run is "faithful" iff its result vector **matches the local oracle per task** (matching, not all-
green — a locally-failing task must also fail in cloud).

**Automated gates (CI-runnable):**
- `run_eval_suite.py --simulate` runs every ready task through the served WMH; boundary tools assert
  `world_model_simulated: true`; a network guard asserts **zero** real Twilio/Stripe/Steel/Vapi
  egress.
- Report-card schema test (fields present, success_rate math, 60s cadence).
- Teardown test: post-run `run_id`-tagged machines == 0, DB dropped, `leaked_resources: []`.

**Approval-gated scale ladder** (each rung → report card → user approval → next):

| Rung | Concurrency | Uniquely validates |
|---|---|---|
| 0 | 1 benchmark | End-to-end plumbing in cloud + served WMH; parity vs local; teardown + cost recorded |
| 1 | 2 concurrent | First concurrency; autoscaler's first scale-up; report card under load |
| 2 | 4 | Scale-up responsiveness + clean scale-down; fast-cache warm |
| 3 | 8 | Served-WMH throughput; fleet + queue behavior |
| … | 2ⁿ | Trend-watch success-rate + cost/task + autoscaler as concurrency doubles |
| N | whole catalog concurrently | Completion criterion: any/all tasks, `--simulate`, green |

Stop condition: the full ready catalog runs concurrently in simulate on the cloud stack, result
vector matches the local oracle, teardown verified, cost metadata complete.

## Open questions / founder-track

- **WMH single-session scaling** (unbounded shared `history`, concurrent-step safety, in-RAM
  retriever growth). Deferred — discuss with WMH authors. This plan accepts current limits.
- **Served-WMH sizing** vs. the tree's peak boundary-call QPS — measured empirically via the ladder,
  not guessed.
