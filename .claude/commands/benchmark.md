---
description: "Run benchmark tasks through the isolated cloud fleet by default; use --local explicitly for local benchmarks and evals."
argument-hint: "list | eval [--bench rose-bench|pipeline-e2e] [--agent-only] [--only a,b] | <slice-or-task...> [-k K --concurrency N] | --local <task...|--full|--rerun-failed latest>"
---

# Benchmark Runner

Use the repository entrypoint for benchmark and eval runs, from the repository root:

```bash
scripts/run-bench $ARGUMENTS
```

Behavior:

- `scripts/run-bench list` prints the benchmark catalog.
- `scripts/run-bench <slice-or-task...>` runs one isolated cloud fleet, with every resolved task running concurrently in its own Machine, database, backend and Temporal queue.
- `scripts/run-bench --local <task-name...>` explicitly selects `agents/benchmarks/local.py` and its isolated local stack.
- `scripts/run-bench eval ...` runs `agents/benchmarks/run_eval_suite.py` through the isolated local stack.
- `scripts/run-bench <task> -k K --concurrency N` runs K independent copies with at most N active. These flags select a bounded campaign; omit them for one fully parallel slice.
- `scripts/run-bench stability-proof -k K --concurrency N --seed S` runs K sequential random slices of N distinct tasks. This proof wrapper has a 32-task width cap; it is separate from the predeploy selection cap of 20. For a wider explicitly requested slice, resolve the concrete task names and pass them together to the ordinary fleet entrypoint.
- `scripts/run-bench <production-only-task>` uses the existing controller-local production runner without allocating Fly guests.

`/deploy` uses `scripts/run-predeploy-local` → `scripts/run-bench --local` by default, with the history-qualified selector and its hard cap of 20; its explicit cloud alternative uses the same fleet scripts. Production payment verification uses `scripts/run-bench agent-payment-production-abandonment`. Keep compact runner regressions in the existing deploy gates; a large live stress run requires an explicit user request and does not become an automatic deploy stage.

Ordinary cloud runs automatically reuse verified completed dependency snapshots,
including from fresh checkouts. Use `scripts/run-bench --help` and CLAUDE.md's
"Cloud startup reuse" guidance; do not rebuild dependencies for source-only changes.

Keep the ordinary 7,200-second backstops. For an explicitly requested five-minute validation, set `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300` and pass `--timeout 300`; the environment setting bounds task execution and the flag bounds the controller path. Preserve terminal task grading, meaningful real execution, exact resource cleanup and the separately monitored E2E deadline. Recovered errors and inner latency measurements remain diagnostics for an infrastructure-only campaign; an ordinary task failure can satisfy that campaign without satisfying the deploy smoke gate.

For an explicitly requested twenty-minute task window, use
`BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200` with `--timeout 1200`. This is a
command-scoped execution setting; keep normal defaults. Run latency proofs
without concurrent paid smoke suites.

The entrypoint owns evaluation publication and the live Hub publisher. Task PASS/FAIL
is emitted before agent/phone cleanup; the fleet publishes changed outcomes on
its next aggregation poll instead of waiting for guest teardown. Exact-owner
acknowledgment follows a matching live Hub response before normal cleanup;
a sixty-second publication wait is warning-only and never prevents resource
release. The frontend polls every five seconds. A terminal run still requires actual resource cleanup
and final publication; early results are not a cleanup receipt.

The entrypoint owns local service startup and teardown, per-run ports, per-run
Postgres container/volume naming through `CONDUCTOR_WORKSPACE_NAME`, frontend
and public tunnel URLs, Temporal task queue naming, non-load benchmark
concurrency, load-test serialization, payment fixture setup, failed-agent
retention, and local diagnostics.

Do not start `scripts/run.sh` manually for local benchmark work unless the user
explicitly asks for a shared existing stack. Use `--use-existing` only when
services are already running and the user wants to reuse `.context/services.json`.

---

# Evaluators (how a bench passes)

Catalog: `agents/benchmarks/tasks.json` (one task = one entry).
Runner: `agents/benchmarks/run_benchmark.py`.
Evidence builders: `agents/benchmarks/semantic_evaluator_evidence.py`.

A task can fail in **two layers**. Both must pass when
`enforce_declared_evaluators: true`.

```
agent run finishes
        │
        ▼
┌───────────────────────────────────────┐
│  Layer 1 — harness contract           │  evaluate_task()
│  expected_attention_kind, tool counts │  always runs
│  approval_handling, progress, etc.    │
└───────────────────────────────────────┘
        │ pass
        ▼
┌───────────────────────────────────────┐
│  Layer 2 — declared evaluators[]      │  _run_declared_evaluators()
│  only if enforce_declared_evaluators  │  ALL must pass (fail-closed)
└───────────────────────────────────────┘
        │ pass
        ▼
      PASSED
```

If Layer 1 fails, Layer 2 is **skipped** (the run already failed).

---

## Declared evaluator methods

| Method                  | What it checks                                                           | How                                                          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `static_check`          | Deterministic facts from run state                                       | Exact checks in `checks[]` (counts, strings, status)         |
| `single_turn_llm_judge` | Semantic criteria against grounded evidence                              | One LLM judge call; score ≥ `pass_threshold` (default `1.0`) |
| `agentic_llm_judge`     | Same idea, larger / tool-using judge                                     | Codex agentic judge over a full trajectory bundle            |
| `polar`                 | Odysseys-faithful per-rubric trajectory + screenshots (polar-bench only) | Isolated module `polar_evaluator.py`; perfect score required |

Supported `static_check` `checks[].type` values are listed in
`agents/benchmarks/long_horizon.py` → `RUNTIME_STATIC_CHECK_TYPES`.

### Semantic evidence (tree-aware — the standard)

For `single_turn_llm_judge` / `agentic_llm_judge`, evidence is **root + every
sub-agent transcript** (hydrated via `get_agent_tree` / `collect_tree_messages`),
plus completion card and `_benchmark` state (approvals, attention kinds).

| Builder                      | Budget                  | Fallback                                  |
| ---------------------------- | ----------------------- | ----------------------------------------- |
| `build_single_turn_evidence` | 320k chars              | If over budget → auto `agentic_llm_judge` |
| `build_agentic_evidence`     | larger per-message caps | n/a                                       |

**Rule:** semantic judges must see browser/sub-agent tool evidence, not root
narration alone. Do not score guest checkout, pickup, or item config from
assistant prose without matching tool titles / payment-approval text / session
metadata.

**Do not** relax criteria, judge prompts, or thresholds to manufacture a pass
(CLAUDE.md rule 25 / process-feedback).

---

## Worked example: `browser-blue-bottle-challenge-recovery`

Task goal: guest-checkout Ferry Building pickup → stop at **one unresolved**
`payment_approval`. Harness never approves the charge.

### Layer 1 — harness fields (same task entry)

| Field                                      | Value              | Meaning                                  |
| ------------------------------------------ | ------------------ | ---------------------------------------- |
| `expected_attention_kind`                  | `payment_approval` | Must see that attention kind             |
| `expected_approval_count`                  | `1`                | Exactly one approval request             |
| `approval_handling`                        | `ignore`           | Leave it unresolved (do not approve)     |
| `success_on_payment_card_request`          | `true`             | Payment-card request is a valid terminal |
| `expected_tool_counts.spawn_browser_agent` | `1`                | One browser session (root scope)         |

### Layer 2 — `evaluators[]` (both required)

#### 1. `blue_bottle_runtime_contract` — `static_check`

| Check                                     | Asserts                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `no_tool_failures`                        | No failed tool calls                                         |
| `browser_agent_session_count` min=1 max=1 | Exactly one browser session                                  |
| `approval_request_count` value=1          | Exactly one approval                                         |
| `approval_request_details`                | Approval text contains `"Blue Bottle"` **and** has an amount |

#### 2. `blue_bottle_pickup_order_semantics` — `single_turn_llm_judge`

Pass only when **grounded** tree/payment evidence shows all of:

1. One 16oz iced vanilla bean shakerato with **almond or oat** milk
2. Blue Bottle **Ferry Building** pickup
3. Order **total** and **pickup time/window**
4. **Guest checkout** used
5. Stops at **exactly one unresolved** payment-card approval
6. Order **not** placed (no confirmation / completion SMS)

Judge may treat the pending payment approval itself as grounding for item,
total, and pickup facts. Live menu name `KSE Shakerato` is OK when config
matches. Fail for auth assistance, approved payment, entered card, completed
order, saved-payment shortcuts that skip guest, fabricated facts, DOM-patched
option labels, or other milk.

### How to read a Blue Bottle fail

| Failure string                                                     | Layer      | Typical meaning                           |
| ------------------------------------------------------------------ | ---------- | ----------------------------------------- |
| `Expected payment_approval attention request … none was triggered` | 1          | Never reached payment                     |
| `Approval request count was N; expected exactly 1`                 | 2 static   | Wrong approval count                      |
| `guest checkout is not directly grounded`                          | 2 semantic | Payment OK; guest UI not in tool evidence |
| `Ferry Building pickup and pickup time/window are not grounded`    | 2 semantic | Item/total OK; location/time missing      |
| `Timeout after 1200s`                                              | harness    | Browser loop never hit terminal           |

### Guest-checkout stack note

This task has no live browser-auth fixture. The stack must export
`BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=true` (via `local.py` /
`tasks_require_disabled_saved_browser_auth`) so sessions stay
`auth_source=none`. Harness-only env is not enough.

---

## Authoring rules (when adding/changing evaluators)

1. Put the contract in `tasks.json` `evaluators[]`; set
   `enforce_declared_evaluators: true` when Layer 2 must gate the pass.
2. Prefer `static_check` for anything countable/string-matchable; use LLM judges
   only for semantic grounding.
3. Assume tree-aware evidence for every new semantic judge (Blue Bottle is the
   proof path — do not broaden weaker evidence modes).
4. Never rename an existing task `name` (history primary key).
5. Never edit prompt / criteria / timeout / pass threshold to make a flaky run
   green — fix the agent or harness boundary instead.

The publisher starts before allocation and forwards starting/ready/running,
evaluated, teardown and released phases. Keep the parent live until resource
release, then publish its final transcripts. Hub transport excludes only
worker/backend/realtime diagnostic logs; complete messages/tree, task metrics
and evidence references remain, and the original local bundle stays unchanged.
