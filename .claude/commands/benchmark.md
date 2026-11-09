---
description: "Run benchmark tasks through the isolated cloud fleet by default; use --local explicitly for local benchmarks and evals."
argument-hint: "list | full [-k K] | eval [--bench rose-bench|pipeline-e2e|process-bench] [--only a,b] | <slice-or-task...> [-k K --concurrency N] [--timeout S] [--check] | --local <task...|--full|--rerun-failed latest>"
---

# /benchmark

Run every benchmark and eval with `scripts/run-bench $ARGUMENTS` from the repository root; it is the only supported entrypoint. Climbing a slice to a pass-rate goal (batches, fixes, reruns) is `/descend`.

## Commands

| Command | What it does |
|---------|--------------|
| `scripts/run-bench list` | Print the catalog |
| `scripts/run-bench <slice-or-task...>` | Run each task at once on the cloud fleet, each with its own Machine, database, backend and queue |
| `scripts/run-bench <task...> -k K --concurrency N` | Run K copies of each task with at most N active; never repeat a task name instead |
| `scripts/run-bench full [-k K] [--check]` | Run every cloud task whose last 3 runs passed (default `-k 2`); needs HEAD pushed |
| `scripts/run-bench --local <task...>` | Run on this box's own isolated local stack |
| `scripts/run-bench eval [--bench rose-bench\|pipeline-e2e\|process-bench] [--only a,b]` | Run the eval suite locally |
| `scripts/run-bench monitor <run-dir> --controller-status <marker>` | Watch a run exactly as its launch printed |
| `scripts/run-bench scorecard <run-dir> --html <run-dir>/scorecard.html` | Render the only allowed card |
| `scripts/run-bench report-format` | Print the card contract |

Over 32 simultaneous copies route to the sharded operator, which needs a clean pushed HEAD; dry-run any launch with `--check` and see `scripts/run-bench --help`.

## Guidelines

### Running
- Run on the cloud fleet by default; use `--local` only when the user asks, and `--use-existing` only when the user asks to reuse running services; never start `scripts/run.sh` for benchmarks.
- Before a fleet run, with Node 22 and `agents/venv` active, run `(cd back-end && node --import tsx -e "require('./scripts/seed-dump-cache.ts')")` and fix any failure.
- Gates run through Machine exec need `agents/venv` active and Node 22's bin first on `PATH`; the default selects Node 20.
- Never build images or refresh dependencies for a source-only change; the CLI reuses verified snapshots.
- Before refreshing cloud dependency snapshots, resolve the complete `agents/requirements.txt` and run `python -m pip check`; an old pool fingerprint never certifies a new environment.
- Reuse an age-limited precheck only from its normal producer with its original bytes and timestamp; rerun it when it has expired or when startup would outlast its remaining lifetime.
- A Benchmark Hub infrastructure experiment does not wait for `/deploy`: point `BENCHMARK_HUB_UPLOAD_URL` (set inside the remote controller command) at an endpoint verified to serve the experiment's source, never write experiment data to the production bucket (a real-R2 experiment uses `BENCHMARK_HUB_STORAGE=r2-isolated` with a fresh `hubxp_<32 hex>` run ID), then publish each real attempt with `hub_upload.py --upload-final`.
- Every launch stops itself when `20 * infra_failed_jobs >= scheduled_total` (30 of 600); never recompute it from completed attempts.
- Cloud startup, recovery, image builds and LIVE acceptance details are in the Operations Runbook in `agents/benchmarks/README.md`.

### Monitoring
- A sub-agent owns each run: launch, monitoring, infra `/RCA` and exact-owner cleanup; it may adopt a run that is already launched through that run's printed monitor handle.
- Watch with the exact printed `monitor` command until the controller exits and its release is verified; a stale observation never justifies a restart.
- Capture the first failure's logs and stop receipts, with a hash-bearing copy receipt, before metadata rotates, and report it through the run's one existing observer.
- To stop your own run, first confirm the controller PID is the process you launched, then TERM only that PID and let its cleanup run; never kill its children or match processes by pattern.
- For a dead owner with retained resources run `scripts/run-bench --recover-stale-owner <exact-token>`; recovery and archives earn no acceptance credit.

### Capacity and cleanup
- Before reporting a Fly cap, read the organization's `machines_per_org_limit` and `python3 scripts/cloudbench-provider-capacity.py cap`; app Machine counts are not organization totals.
- Reuse eligible Machines before allocating more, and fresh-only flags never bypass reuse; allocate only for a measured unmet need with verified provider headroom, and a provider limit error never authorizes retrying creates.
- When a limit blocks you, keep working on existing Machines or local gates and report the remaining allocation gap.
- After any failed or cancelled run, stop verified-idle owned Machines through their controller's normal cleanup, keeping IDs, volumes and evidence; `scripts/run-bench reclaim-stopped` destroys stopped task Machines and their volumes, so run it only on Machines whose evidence is preserved.
- Ownership alone grants no reuse or cleanup authority; never touch retain-policy resources or another workspace's.

### Reporting
- Before reporting, read the contract each launch prints and publish only the rendered card; never hand-write or edit it.
- The parent posts the card at start, every 15 minutes, when nothing is left queued and at end.
- When giving the user an FE link to a run's agent, verify it shows the agent.

## Evaluators

- A run passes only when both layers pass: the harness fields of its `tasks.json` entry (`expected_attention_kind`, tool counts, `approval_handling`), then every `evaluators[]` entry when `enforce_declared_evaluators` is true; a Layer 1 failure skips Layer 2.
- Methods: `static_check` (exact counts, strings and status; types in `RUNTIME_STATIC_CHECK_TYPES` in `agents/benchmarks/long_horizon.py`), `single_turn_llm_judge` (one judge call, score at least `pass_threshold`, default 1.0), `agentic_llm_judge` (a Codex judge over the whole trajectory, used automatically when single-turn evidence exceeds 320k characters) and `polar` (polar-bench only).
- Semantic judges see the root and every sub-agent transcript plus benchmark state; never score from assistant narration without matching tool evidence.
- Prefer `static_check` for anything countable and LLM judges only for semantic grounding; never rename a task `name`, and never relax criteria, judge prompts, thresholds or timeouts to make a run pass.
- A guest-checkout task with no browser-auth fixture needs the stack to export `BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true` (via `tasks_require_disabled_saved_browser_auth`).

## References

`agents/benchmarks/README.md` (Operations Runbook), `.claude/shared/benchmark-report-format.txt`, `.claude/commands/descend.md`, `docs/testing.md`.
