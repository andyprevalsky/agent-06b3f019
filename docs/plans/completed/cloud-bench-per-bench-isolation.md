# Cloud bench: per-bench isolation, per-bench sim, cost accounting, concurrency ladder

Owner directives (2026-07-08):
1. **Finish first** — each bench runs on **isolated resources** (own db / backend / Temporal queue / **WMH**), autoscaling like the prod pool. (folds in #3)
2. **Concurrency ladder** — after #1: run n=1, then n=2, 4, 8 … up to all benches at once. **Approval gate between rungs**; **RCA every failure** and fix before advancing.
3. **Sim per benchmark** — sim on/off is a per-bench property (isolation from #1 is what makes it enforceable). **Default all sim OFF**; owner flips specific benches to sim ON during the #2 cycle.
4. **Cost accounting** — WMH tokens count toward run token totals; **vCPU/infra $ per task + total**. **Do #4 before #2.**

Sequence: **#1 → #4 → #2.**

## Current state (verified)
- `run-bench-cloud` boots **one** warm Fly machine (`navi-whisper-lux-bench`); `cloudbench-run.sh` runs **one** `run.sh --benchmark` stack (one pg / backend / queue / WMH); all tasks in a run execute **concurrently on that one stack** (`max_concurrency=5`). Isolation is **per-run, not per-bench**. `peak_machines` hardcoded to 1.
- WMH mode is a **process-global** env (`BENCHMARK_WORLD_MODEL_MODE`), set once per run — **no per-bench toggle**. `environment.mode` (`hybrid|synthetic|live`) is a data-fixture taxonomy, not the WMH toggle.
- Cost block: `wmh_grounding_usd` (from served WMH) folded into `total_usd`; `metadata.tokens_in/out` are **agent-tree tokens only** (WMH tokens excluded); **no infra/vCPU cost** anywhere.

## Step 1 — per-bench isolation (+ per-bench sim field)
**Architecture (proposed): one ephemeral Fly machine per bench.** Each concurrent bench gets its own machine running the existing `cloudbench-run.sh` stack (own pg/backend/queue/WMH) — i.e. `1 bench = 1 world = 1 tree = 1 isolated stack`. Concurrency = machine count (managed via a warm pool + Fly machine clone/scale), which is the "autoscaling like prod" behavior. `run-bench-cloud` becomes a fan-out orchestrator: allocate N machines, run one bench per machine, aggregate report cards/run records across machines into the single dashboard, tear down.
- **Per-bench sim:** add `world_model_mode` (`"real"` default = sim OFF | `"simulate"` | `"shadow"`) to each `tasks.json` entry; `cloudbench-run.sh` exports it per-machine so each isolated stack runs its bench in its own mode. Extend `long_horizon.py:validate_catalog()`.
- **Dashboard:** per-task **SIM/REAL badge** in the per-task table + a run-level legend; drive from the per-task `world_model_mode`.
- **⚠️ Safety:** sim OFF = the bench hits **reality**. For `browser-agent*`, `*-payment`, `build-boxing-payment`, `outreach-batch`, `phone-call-*`, `job-applications`, `calendly-schedule-meeting`, `minted-agent-accounts-*`, `linkedin-data-download` that means real purchases / messages / calls / logins. Gate each of these before its first real run.

**Verification (automated):** new blackbox — spin 2 benches, assert 2 distinct queues/DB names/WMH ports/machine ids and that a `world_model_mode:"simulate"` bench served WMH while a `"real"` bench did not; `validate_catalog()` covers the new field both directions.

## Step 4 — cost accounting (before the ladder)
- WMH tokens: fetch WMH token in/out (alongside `wmh_grounding_usd`) and add into `metadata.tokens_in/out` (or a separate `wmh_tokens_in/out`), surfaced on the dashboard.
- Infra: compute Fly machine cost = vCPU-seconds × Fly rate (by machine size), apportioned per bench by wall-clock; add `per_task.infra_usd` + a run-level `cost.infra_usd`; fold into `total_usd`. Dashboard: infra column + total.
- **Verification:** `report_card_test.py` cases for token folding + infra apportionment; `run_benchmark_wmh_cost_test.py` for the WMH-token fetch.

## Step 2 — concurrency ladder (after #1, #4)
Driver: run n=1 → RCA/fix any failure → **request approval** → n=2 → … → all. Each rung uses per-bench isolation; owner sets sim on/off per bench before its rung. RCA per `docs/root-cause-analysis.md`; never advance a rung with a known failure.

## Viewer (decided)
Run-scoped: spins up on first "open" click during the run, reaped on exit (`stop_all_local_viewers`). Post-run browsing is opt-in (`CLOUDBENCH_PERSIST_ARCHIVE=1`) or re-spun from the saved `run.json`. RCA uses the saved `run.json` + `agent_latency.py`/`agent_logs.py`.

## Decisions (confirmed 2026-07-08)
- **A. Isolation granularity → one ephemeral machine per bench** (owner: "per machine option 1"). Concurrency = machine count.
- **B. Sim-off safety → owner gates sim per batch.** Default all `real` (sim off); before each N=X rung, present the queued benches and the owner names which to flip to `simulate`. Do NOT auto-run real-side-effect benches (payment/outreach/phone/browser) without that per-batch direction.
- **WMH distribution → `fly machine clone`.** The WMH model lives on the `/data` volume (not the image), so each per-bench machine is a clone of the warm box (clone forks the volume incl. `/data/world-model`). N benches → N clones, each running `cloudbench-run.sh` for its one bench in that bench's `world_model_mode`; reap all on exit.

## Progress
- **Done + tested (local):** run-scoped viewer lifecycle (`stop_all_local_viewers`, opt-in persist); per-bench `world_model_mode` field + `validate_task_contract` enum; report-card per-task `world_model_mode` (inherits run mode / per-bench override); dashboard per-row SIM/REAL/SHADOW badge. 100 benchmark pytest + catalog validate + ruff green.
- **Next (the bulk):** rewrite `run-bench-cloud` from single-box to N-clone fan-out (one bench per clone, per-bench mode from catalog, card aggregation across clones, teardown). Verify with an N=2 cloud run.
