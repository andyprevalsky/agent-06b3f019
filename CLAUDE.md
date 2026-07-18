# Rose Labs

AI agent platform with model racing infrastructure.

- Production: https://roselabs.ai
- Backend API: https://navi-j9a9.onrender.com
- API Docs: https://docs.roselabs.ai

## Architecture

```
front-end/        → React/TypeScript/Vite (Vercel)
back-end/         → Express/TypeScript/Prisma (Render)
agents/           → Python Temporal workers (Fly.io)
research/gepa/    → Offline reward-model pipeline (no runtime services)
mac-app/          → Electron desktop app (macOS only)
docs/             → API documentation (Mintlify)
claude-code-src/  → Vendored Claude Code source (READ-ONLY reference). Its
                    prompts and agent loop are extensively battle-tested;
                    our repo is still at the 0-users stage. Lift patterns
                    liberally when designing or refining our agent harness.
openclaw/         → Cloned OpenClaw repo (READ-ONLY reference, gitignored —
                    not committed to keep parent repo lean). Open-source
                    agent harness; useful prior art for tool layouts, system
                    prompts, and orchestration patterns. Re-clone with
                    `git clone --depth 1 https://github.com/openclaw/openclaw.git`
                    if missing locally.
hermes-agent/     → Cloned Nous Research hermes-agent (READ-ONLY reference,
                    gitignored). Reference implementation for tool-calling
                    + reasoning prompts. Re-clone with
                    `git clone --depth 1 https://github.com/nousresearch/hermes-agent.git`
                    if missing locally.
```

> **Reference repos policy:** `openclaw/` and `hermes-agent/` are gitignored
> (sit alongside `claude-code-src/` but are NOT committed). Treat as
> read-only research material — do not edit them. If they're missing on a
> fresh clone, run `bash scripts/sync-reference-repos.sh` to restore.

## Prompt review tool

`prompt-review/` ships a small local web app for reviewing every prompt in
this repo against three reference codebases side by side. Five columns:
**current → ~1 month ago → Claude Code → OpenClaw → Hermes**. Notes are
saved per prompt; checkpoint state persists across reloads.

```bash
bash prompt-review/run.sh                     # rebuilds data + launches on :8765
PROMPT_REVIEW_PORT=9000 bash prompt-review/run.sh   # custom port
```

- Catalog: `prompt-review/catalog.json` (edit to add/remove prompts).
  Each OUR entry has a `matches` field with hand-picked semantic pairings
  for each reference repo (`claude`, `openclaw`, `hermes`); a value of
  `null` means "no equivalent in that repo" and the column shows
  "no equivalent" instead of a low-quality keyword match. Edit
  `prompt-review/render/apply_explicit_mappings.py` to refine pairings.
- Build: `python3 prompt-review/build.py` (extracts text + git history +
  resolves matches via explicit mapping first, keyword fallback otherwise).
- Notes/checkpoints: `prompt-review/checkpoints/state.json` (gitignored)
- Weak matches (no good correlary in the reference repo) get a teal `WEAK`
  flag in the column header. Match-source badges: blue `manual` (explicit
  semantic pairing) vs gray `auto` (keyword fallback).

**Key entry points:**

- `front-end/src/App.tsx` - React app
- `back-end/src/server.ts` - Express server
- `agents/worker.py` - Temporal worker
- `agents/workflows/agent_workflow.py` - Core agent logic
- `back-end/prisma/schema.prisma` - Database schema (source of truth)
- `back-end/src/providers/rose/client.ts` - In-process Rose completions (chat path)
- `agents/providers/rose/client.py` - In-process Rose completions (agents path)
- `mac-app/main/index.ts` - Electron main process
- `docs/mint.json` - Mintlify docs config

**Mac app releases:** PRs that include `mac-app/` changes should be labeled `MAC-APP-RELEASE`. When a PR with this label is merged, CI automatically bumps the patch version, creates a git tag, and pushes it — which triggers the full release workflow (build, sign, notarize, upload). No manual tagging needed. You can also trigger a release manually by pushing a git tag (e.g., `git tag v1.0.14 && git push origin v1.0.14`). **Any `front-end/` changes also require a mac-app version bump** (new git tag push) so the Electron app rebuilds with the updated frontend.

## Development

Run all services via Conductor (see `conductor.json`).

**Tests:** See `docs/testing.md` for the full guide. Quick:

```bash
bash scripts/test.sh --port=3001                   # everything: offline + smoke + semantic (requires running services)
bash scripts/test.sh --no-smoke                    # offline-only (skips smoke + semantic)
bash scripts/test.sh --no-smoke agents web-search  # single repo/domain (offline)
bash scripts/test.sh --list                        # list available repos/domains
```

**Backend tests (direct):**

```bash
cd back-end && npm run test:api         # Backend API tests
cd back-end && npm run test:coverage    # Backend coverage check (enforces thresholds)
cd back-end && npm run test:coverage:report  # Coverage report without threshold enforcement
cd front-end && npm run test            # Front-end blackbox + structural tests
cd front-end && npm run test:coverage   # Front-end coverage check (enforces thresholds)
cd front-end && npm run test:coverage:report  # Front-end detailed coverage report
cd mac-app && npm run test:coverage     # Mac-app coverage check (enforces thresholds)
cd mac-app && npm run test:coverage:report  # Mac-app detailed coverage report
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py  # Agent blackbox tests
cd agents && python tests/e2e/run_e2e_tests.py --basic  # E2E agent tests (spawns real agents via API)
cd agents && bash scripts/run-coverage.sh            # Agents coverage check (enforces fail_under)
cd agents && bash scripts/run-coverage.sh --report   # Detailed report without threshold
cd agents && bash scripts/run-coverage.sh --html     # HTML report in htmlcov/
cd mac-app && npm run test                   # Mac-app blackbox suite (vitest + MSW, jsdom)
cd mac-app && bash scripts/run-blackbox-tests.sh <domain>  # Mac-app blackbox: single domain
```

**Code coverage:**

- **Backend** requires minimum 88% line/statement, 87% function, 76% branch (see `back-end/.c8rc.json`).
- **Front-end** requires 80% lines, 75% statements/functions, 70% branches (see `front-end/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines, ~79% statements, ~77% functions, ~72% branches. Target: 80% across all four.
- **Mac app** requires 80% lines/statements/functions and 85% branches (see `mac-app/vitest.config.ts` → `coverage.thresholds`). Current: ~80% lines/statements, ~84% functions, ~85% branches. Thresholds ratchet up and never down.
- **Agents** requires 80% line+branch (see `agents/pyproject.toml` → `[tool.coverage.report]`). Current: 81%.
- Thresholds ratchet — only increase, never decrease. Bump after adding tests.

**Benchmarks:** See `agents/benchmarks/README.md` for the full CLI reference. Quick: `scripts/run-bench list`. For local iteration, prefer `scripts/run-bench <task...>` or `scripts/run-bench --rerun-failed latest`; the local wrapper starts an isolated `scripts/run.sh --benchmark` stack with per-run ports, DB container/volume name, frontend/public URL, Temporal task queue, and manifest under `.context/benchmarks/<run-id>/`, runs selected tasks with max concurrency 5, keeps failed agents long enough to run `agent_latency.py`, `agent_logs.py`, and `agent_cache.py`, then tears services down. To checkpoint any single benchmark, use `scripts/run-bench <task> --checkpoint <turn_n>`; the runner creates the source by running that benchmark to the root message index, pauses/exports it, and resumes a cloned checkpoint. Add `--checkpoint-no-start` to create a paused FE-visible checkpoint, then resume it with the printed `--checkpoint-start-agent-id` command. Use `scripts/run-bench --full` only when you intentionally want the whole local suite. Use `scripts/run-bench eval` for the full eval suite through the same isolation layer. Direct `run_benchmark.py --port N` remains the lower-level path for already-running services or special cases. Simulator run: `cd agents && python benchmarks/run_benchmark.py --task <task> --simulate --world-model-url http://localhost:<wmh-port> --world-model-name <model>`; add `--wmh-eval` when you want post-run prediction-accuracy scoring recorded in the benchmark JSON. R2 trace-corpus hygiene: `cd back-end && TRACE_ARCHIVE_BACKEND=r2 npx tsx scripts/curate-trace-archive.ts --all --dry-run`; use `--delete` only to remove non-gold legacy/partial bundles after reviewing the dry-run report. The `/benchmark` command delegates to `scripts/run-bench` so Claude and shell users share the same isolation/concurrency behavior.
- Every time a benchmark task is run, include the valid FE link to view the run (for example, `http://localhost:5050/?agent-id=ac267c32-470f-41da-8343-091b8965c410`) and verify it actually displays the agent.

## Eval Suite

**`agents/benchmarks/tasks.json` is the ONE canonical benchmark catalog.** Benchmark tasks and migrated long-horizon evals live here; ordinary blackbox/vitest tests do not. Each entry carries the additive eval contract: `status`, `runner` (`agent`), `bench` (`pipeline-e2e` for Rose harness plumbing vs. `rose-bench` for harness-independent capability), `description`, `environment` (mode/db_fixtures/base_images/services/secrets/live_targets/context_notes), `evaluators[]` (`static_check` | `single_turn_llm_judge` | `agentic_llm_judge`), and `source` (provenance pointers). Validated by `agents/benchmarks/long_horizon.py:validate_catalog()`. Idea kernels that haven't become evals yet live in `agents/benchmarks/long_horizon_ideas.json`.

**The single full-suite entrypoint:** `cd agents && python benchmarks/run_eval_suite.py --port N`. It runs every `status: "ready"` benchmark entry through `run_benchmark.py` and lists `status: "incomplete"` entries (missing fixtures/judges) as skipped. `--list` prints the holding set split by `rose-bench` vs. `pipeline-e2e`; `--bench rose-bench` or `--bench pipeline-e2e` runs one axis. Run this after every agent-harness change to evaluate whether progress is being made.

**The FE query box reads this same catalog** via `GET /api/benchmarks/test-prompts` (adapter in `back-end/src/domains/benchmarks/service.ts`); the dev test-prompts picker cannot drift from the suite.

**Every task runs on a base-image fixture.** Tasks that don't declare `environment.base_images` inherit `base:victoria-prod-sync-v1` (the workspace DB synced from prod via `scripts/setup-db.sh`) at load time; declared environments with empty `base_images` inherit it too. Registry + pg_dump freezer: `agents/benchmarks/fixtures.py` (`ensure_base_image_snapshot()`). Task-specific `db_fixtures` are deltas on top of a base image.

**Every completed run is recorded — pass or fail, local or prod.** `BenchmarkRun.save()` writes the full run record (message transcripts + logs) to `runs/*.json`, appends every attempt to the attempts ledger, and full LLM trajectories land in `.llm-dumps/<agent_id>/` (always-on locally; prod goes to ClickHouse).

**⛔ Never rename an existing task `name`.** The name is the primary key across all history stores; a rename orphans pass history and latency baselines:

- **Attempts ledger:** `agents/benchmarks/history/task_attempts.jsonl` — one line per *completed* run (pass AND fail) with status, duration, cost, failure_reason. Written by `benchmarks/timeout_history.py:record_attempt()`. This is the run-stats record (attempt counts, failure rates).
- **Success ledger:** `agents/benchmarks/history/task_durations.jsonl` — one line per *passing* run, keyed by `"task"`. Read via `benchmarks/timeout_history.py` (`summary()` → p50/p95, derived timeouts). Kept pass-only so failure durations can't poison timeout derivation.
- **p99/latency baselines:** `agents/benchmarks/history/span_durations.jsonl` — keyed by `"benchmark"` + `"span_key"`. Read via `benchmarks/span_history.py` / `agent_latency.py` (p50/p90/p95, regression flags).
- **Full run records:** `agents/benchmarks/runs/*.json` — per-run task results + merged logs, keyed by `TaskResult.name` (`run_benchmark.py --compare A B`).

One task name threads all three stores, so any eval is traceable end-to-end: definition (tasks.json) → pass history → latency profile → run record.

## Log Files

Check these when errors occur:

- **Agents:** `agents/navi-worker-log.txt`
- **Backend:** `back-end/backend-logs.log`
- **Frontend:** `front-end/frontend-logs.log`
- **Mac App (console):** `mac-app/mac-app-console-logs.log`
- **Mac App (IPC):** `mac-app/mac-app-ipc-logs.log`
- **Docs:** `docs/docs-logs.log`

**Prod logs (for benchmark agents):** Benchmark runs auto-collect logs from retained ClickHouse rows and live service APIs into the result JSON (`agents/benchmarks/runs/*.json`):

- **Render (backend):** HTTP request logs filtered by `agent_id` — via `RENDER_API_KEY` in `back-end/.env`
- **ClickHouse (retained Fly.io worker):** Agent execution logs from `observability.fly_logs`, retained 7 days — via `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USER`, and `CLICKHOUSE_PASSWORD` in `agents/.env`
- **Fly.io (live worker stream):** Live agent execution logs during benchmark runs — via `FLY_API_TOKEN` in `agents/.env`

See `agents/benchmarks/README.md` → "Reviewing Benchmark Logs" for CLI snippets to inspect these.

## Debugging Slow Agents

Three diagnostic tools. Run **all three in parallel** whenever an agent is slow, stalled, or fails — they answer different questions. Then fully expand whichever one points at the smoking gun.

```bash
cd agents && source venv/bin/activate

# "Why was this slow/stalled?" — span-based cross-log waterfall + hot paths
python benchmarks/agent_latency.py <agent_id>
# Flags: -v (verbose/full tree), --speedscope OUT.json, --stall-threshold N,
#        --slow-threshold MS, --no-color

# "What errors happened where?" — event-timeline tree across worker/backend/messages
python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
# Expand per-source: --source worker|backend|messages  (add --url <BASE> for prod)

# "How much did this cost / cache?" — tree-wide token + cache breakdown
python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>
# Cache metrics are tree-aggregated (root + all sub-agents via /api/tool-usage/tree/:id)
# Results stored in agents/benchmarks/runs/*.json

# "Where are cache hits/misses?" — file-tree view of prompt caching per LLM call
python benchmarks/agent_cache.py <agent_id>
# Flags: --all (all agents), --since 5m, --json, --log <path>
```

**`agent_latency.py`** reads `agents/navi-worker-log.txt` and `back-end/backend-logs.log`, builds a span tree from `span.start`/`span.end`/`db.query`/`broadcast.span` events (correlated by `span_id`/`parent_span_id`, falling back to `request_id` + time-window containment), and prints:

- Executive summary: re-run command, total duration, span count, error count.
- **Top 10 slowest paths**, **Slowest LLM Calls**, **Slowest Backend HTTP Requests**, **Errors** (deduped with counts).
- A hierarchical waterfall (`offset | dur | trace`) nesting sub-agents under their spawn call. Inline `IDLE` markers for gaps above `--stall-threshold`.
- `-v` expands every span (DB, broadcasts, HTTP internals).

**`agent_logs.py`** dumps the cross-source event timeline (including prod via Render, ClickHouse, and Fly APIs with `--url`), grouped into a tree with errors highlighted. Best for reading the exact error message + stack + surrounding context after `agent_latency.py` points at a layer.

For retained Fly.io worker logs, query ClickHouse directly:

```bash
cd agents && source .env
curl -sS -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" --get "$CLICKHOUSE_ENDPOINT" \
  --data-urlencode "query=SELECT timestamp, raw FROM observability.fly_logs WHERE raw LIKE '%<agent_id>%' ORDER BY ingested_at ASC LIMIT 200 FORMAT JSONEachRow"
```

**`agent_cache.py`** reads `agents/navi-worker-log.txt` for `llm.cache` events and renders a tree of cache read/write/hit% per LLM call, grouped by agent. Shows every call site (plan_loop, planner, verifier, explore, execute, chat) with its model, whether it used claudeAuth (direct Anthropic = $0) or waterfall, and per-call cache metrics. Use `--all --since 5m` for a cross-agent overview after running benchmarks.

Typical signatures to look for: `peer closed connection` during streaming, `[NO END]` on an LLM call (crashed/cutoff mid-stream), `Failed to fetch pricing` retries (underlying-model 404s burning 30s each), P2024 Prisma pool timeouts (5s × 3 retry on `db.findFirst`), 429 from Anthropic on the `claude_token` path (rate-limit fallback to waterfall), `thinking.adaptive.effort: Extra inputs` (effort must go in `output_config`, not `thinking`), 0% cache hit on claudeAuth (check `cache.prefix_fingerprint` hashes match across calls — differing hashes = different prefix = no cache reuse).

## Critical Rules

1. **NEVER fire an async/background task and then passively wait for it to wake you up later.** This is the number-one guideline. Do not launch a background job — a `run_in_background` Bash task, a spawned sub-agent, a benchmark/smoke/`run.sh`, a cloud fleet run, any detached `&` — and then sit idle expecting a completion notification. **The wake-up may never come:** the task can be SIGKILLed by resource pressure, die silently, leak paid resources (Fly machines, sandboxes), or the notification can simply be missed — and you stall indefinitely while cost bleeds. ALWAYS actively drive every async task you start: poll it on the rule-19 cadence (every 10s for the first 60s, then every 60s), check BOTH output growth AND liveness (`ps`/`pgrep`), and the instant it dies or finishes, react — clean up leaked resources, diagnose, re-run. Treat any harness notification as a bonus signal, never the primary one. If you catch yourself writing "waiting for it to complete" or "I'll continue when it notifies me," stop and go poll it instead.

1b. **Every trajectory must leave the system more reliable than it found it.** When you hit friction in a part of the codebase or tooling you're using — a broken teardown that leaks resources, a script that orphans child processes on kill, a missing retry on a transient error, a footgun that nearly clobbered a shared resource, a flaky gate — do NOT just work around it for yourself. FIX the underlying issue so no future agent (or human) hits it again, then verify the fix. The cost of a workaround is paid once by you; the cost of the unfixed defect is paid by every future run. This is not scope creep — it is the job (see rule 24). If a fix is genuinely too large to land now, at minimum capture it durably (a memory, a tracked issue, a `TODO` with full context) so it is not silently re-encountered. "It worked for me this time" is not done; "future runs can't hit this" is.

0. **Bias toward execution — each pause to check for user approval has an extremely high cost.**

0a. **Be a TANK: don't ask, iterate until prod actually works.** When a task is "make X work in prod" (get a gate green, ship a fix, prove a flow end-to-end), OWN it end-to-end without pausing to ask permission for each step — the user has standing authorization to keep going until the real-world outcome is achieved (gate green, agent verified live, purchase completed). **RCA every issue you hit along the way and FIX it, even when the issue is not directly your task** — a stale CI secret, a flaky harness, a broken teardown, a mis-scoped token, someone else's never-green gate. Scope increase is expected, not a reason to stop (see rules 1b and 24). Before assuming an issue is yours to fix from scratch, **check whether another branch already has the fix in flight** (`git log --all`, open PRs) — if so, wait for it or cherry-pick rather than duplicating. Keep a tight iterate loop: reproduce → diagnose from evidence (logs, not guesses) → fix root cause → re-run the real gate → repeat until it is genuinely green. "It probably works now" is not done; a green prod gate (or a verified live run) is done. Only stop to ask when an action is genuinely irreversible/destructive or spends real money beyond what was authorized.

1. **Functionality is only guaranteed if a test measures it and that test is cemented in a consistently-run path** (blackbox, pre-deploy, daily, or any suite run via `/deploy` or an equivalent recurring gate). Due to the nature of agentic coding, regressions are EXTREMELY likely — the app is only as good as its test suite. Therefore prioritize test-driven development. Any behavior that lacks a cemented test is assumed broken until proven otherwise, and any bug we fix per RCA MUST land its reproduction test in the deploy process so the regression can never silently return.

2. **TDD loop** - Don't return until tests pass:

   ```
   while tests_failing:
       fix_errors()
       run_tests()
   ```

   When fixing a new issue that is not illuminated by a failing test:
   1. Diagnose the issue
   2. Create a test that reproduces the issue
   3. Fix the issue until the test passes
   4. Cement that test in a consistently-run suite (per rule 1) so the fix is permanent

3. **API changes require tests** - Add to `back-end/src/tests/blackbox/<domain>.blackbox.ts`

4. **No .md files** - Never create markdown docs unless explicitly requested

5. **Zod schema changes require approval** - Propose changes before implementing

6. **Follow RCA methodology for every bug** - Before diagnosing any bug, read `docs/root-cause-analysis.md` and follow the steps exactly. Never skip the evidence-gathering step (Step 0), never fix a symptom without tracing the critical path, and never rationalize a failure as "pre-existing"

7. **Search before implementing** - When adding new features, first search the codebase for similar patterns (e.g., when adding a new tool, study existing tools)

8. **No fallbacks during development** - When testing a new integration, don't add fallback paths; they obscure whether the primary path actually works

9. **Frontend state diagrams required** - All frontend components must have a state machine diagram as a comment at the top of the file; reference and keep this diagram up to date when modifying state flow

10. **Feature changes require diagrams** - When implementing any feature, include a diagram showing how the change fits into the system context before writing code.

11. **Pauses are user-initiated, not fixes** - When debugging, NEVER assume a pause caused a bug/crash. The user sends a pause AFTER noticing something wrong. Pauses are the symptom reporter, not the cause.

12. **Short timeouts, check logs** - Never set bash timeouts longer than 5 minutes; use short timeouts and check task output periodically to ensure long-running tasks complete smoothly.

13. **Do NOT over-truncate** - Never aggressively truncate content, especially important context flows. Truncate SPARINGLY and only when necessary to fit content inside a frontend component (e.g., chip/bubble UI with limited space). When in doubt, keep the full content.

14. **Sync Conductor workspace name on branch change** - Whenever you switch or create a branch, update the Conductor workspace display name to match — **but only if it's not locked**:

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = '$(git branch --show-current)' WHERE directory_name = '$(basename \"$PWD\")' AND pr_title_locked = 0"
```

To manually rename and lock (prevents auto-sync from overwriting):

```bash
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title = 'My Custom Name', pr_title_locked = 1 WHERE directory_name = '$(basename \"$PWD\")'"
```

15. **Plans must have automated verification** - Every plan's verification section must describe automated tests, not manual steps. If no existing test route covers the change, create one. If you need API keys, configs, or other resources to test, ask for them in the plan. The goal: once a plan is approved, bring the feature all the way through to PR merged into main using `/deploy`.

16. **ALL test failures must be fixed — no exceptions** - Never rationalize test failures as "pre-existing", "not related to my changes", or "infrastructure issues." This applies to EVERY test tier: Prettier, ESLint, TypeScript, structural tests, coverage, blackbox tests, AND smoke benchmarks. If a test fails, you MUST fix it before proceeding. Do NOT skip, do NOT rationalize, do NOT merge with known failures. If smoke benchmarks fail due to expired tokens, fix the tokens. If they fail due to Temporal issues, fix Temporal. If they fail due to slow LLM responses, investigate and fix timeouts. "Infrastructure issue" is a diagnosis, not an excuse to skip. The local DB (Docker Postgres) must be running for blackbox tests — `run-blackbox-tests.sh` auto-detects the container via `CONDUCTOR_PORT`/`CONDUCTOR_WORKSPACE_NAME`. If the container isn't running, start it: `docker start victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}`.

17. **Bug diagnosis guidelines** - When diagnosing issues found while running any tests, follow `docs/root-cause-analysis.md` exactly. Gather evidence first, trace the critical path, classify the failure, and complete Step 5's hypothesis fields (including the generalizable Problem class) before writing any fix.

18. **Validate via blackbox tests, not hand-rolled scripts** - When validating credentials, tokens, integrations, or any pipeline behavior, run the existing blackbox test (e.g. `testSmoke_claudeCodeAnswersQuestion` in `back-end/src/tests/blackbox/claude-code.blackbox.ts`) — NEVER write ad-hoc curl/python scripts to hit Anthropic/Supabase/etc. directly. The blackbox exercises the FULL path (DB read → decryption → E2B sandbox → Claude Code CLI → Anthropic) the way production does; a raw curl only tests one hop and misses layer-specific bugs. If no blackbox covers the case, extend the existing suite first, then run it.

19. **Background-task monitoring cadence** - Whenever a long-running task is launched in the background (smoke suites, benchmark runs, `run.sh`, agent polling, any `run_in_background=true` bash, or a raw `&` shell job), monitor it on this schedule:
    - **First 60 seconds:** poll every **10 seconds**. Catches silent early deaths (0-byte log, missing env, queue mismatch, PID died at startup). Check both log growth AND `ps -p <pid>` — a dead PID with no output means the task never started.
    - **After 60 seconds:** poll every **60 seconds**. The early-death window is over; longer intervals save context and tokens.
    - **Exit the moment the task finishes.** The instant you see the completion signal (exit code, "RESULTS: N/N passed", PID gone, "DONE" line), stop polling and move on. Do NOT sleep out the remaining interval. Do NOT keep polling after completion "to be safe."
    - This rule is universal — it applies everywhere, not just in `/deploy`. If a background task burns 10+ minutes before you notice it died, that is a rule-19 violation.

20. **Temporal activities must be idempotent** - Temporal activities are at-least-once. Any activity can run, complete its external side effect, and then fail to report completion back to Temporal because the worker-to-Temporal completion RPC was canceled, disconnected, or otherwise not recorded. Temporal will then retry the activity after the attempt timeout. Therefore every activity that writes to the backend, calls an external service, creates files, sends messages, charges money, or performs any other side effect MUST be safe to run more than once. Before performing a side effect, check whether the intended result already exists and return it when possible; otherwise use an idempotency key/deduplication record so retries do not duplicate work. Never assume "the activity returned locally" means Temporal recorded completion.

21. **Never `git stash`** - The stash ref is shared across all worktrees in this repo; popping can pull another workspace's in-flight work. Instead: `git diff HEAD > .git-wip.patch && git checkout -- .`, then `git apply .git-wip.patch && rm .git-wip.patch` to restore.

22. **Never disable linters** - Do NOT add `eslint-disable`, `// eslint-disable-next-line`, `/* eslint-disable */`, `// @ts-ignore`, `// @ts-expect-error`, `# noqa`, `# type: ignore`, `# pylint: disable`, `ruff: noqa`, or any equivalent escape hatch to silence a rule. Fix the underlying issue. Existing disables in the codebase should be removed when you touch the file.

23. **New user data providers** - When integrating a new user data provider, first model it as a normalized, grep-searchable document source with explicit sync state, source metadata, snapshot revision semantics, prod-path tests, and a prod-data benchmark before adding bespoke provider behavior.

24. **Clean up tech debt as you discover it — scope increase is expected** - When a file under edit has pre-existing lint errors, type errors, test failures, dead code, or other debt, fix it in the same PR. Do NOT rationalize "pre-existing" or "out of scope" to leave it. Scope increase beyond the narrow task is not only allowed but anticipated — bundle the cleanup with the change that exposed it. **Any error surfaced by a failing test, lint, typecheck, coverage check, or other gate is automatically in scope — even in files you did not touch.** If the deploy pipeline (or any required check) reports the error, fix it; do not skip it as "not my file" or "not my change."

25. **No benchmark reward hacking** - Never change benchmark task definitions, prompts, expected tools, pass criteria, load sizes, timeouts, concurrency limits, or production behavior just to make a benchmark pass. Do not raise a benchmark/tool timeout as a workaround for a timeout failure. First prove why it timed out with diagnostics: resource contention, memory growth, blocked external tool/session, retry loop, verifier/schema issue, slow database/API calls, or an unintended parameter/config change. Then reduce the underlying resource use, remove the stall, or fix the broken flow. Get explicit approval before changing any benchmark definition or timeout. General reliability rule: any Temporal activity wrapper that calls an LLM must allow at least 60 seconds; sub-60-second verifier/LLM activity timeouts are product bugs, not benchmark tuning.

26. **Prompt approval is snapshot-scoped** - Human approval for prompt, instruction, command, skill, or prompt-related changes applies only to the diff that existed when approval was requested. If any later fix or test iteration adds or changes prompt-related files, stop and request fresh approval for those additional hunks before running deploy with the prompt approval flag. Never treat "prompt changes approved" as blanket permission for future prompt edits.

27. **Every change must hold at 10k agents** - The design target is 10,000 concurrent agents. Before shipping ANY change, ask "what happens to this at 10k agents?" and reject designs that degrade with agent count. Concretely: no per-user/per-root fan-in that funnels many agents' traffic through one channel, connection, subscription, row, lock, or in-memory structure (e.g. broadcasting every agent's realtime stream onto a shared `user:<userId>` topic is a firehose that melts at scale — keep per-agent isolation like `agent:<id>`); no unbounded per-agent polling, N+1 queries, full-table scans, or O(agents) work on a hot path; no shared mutable state, global counter, or single-writer bottleneck that every agent contends on; no realtime/broadcast/DB pattern whose cost grows with the number of agents a user or tree owns rather than with the one agent being acted on. Prefer per-agent isolation, bounded/backpressured work, sharded/keyed resources, and derive-don't-accumulate. A fix that resolves a 1-agent symptom but scales O(agents) is not a fix — state the 10k-agent behavior of your change (channels opened, subscriptions held, rows/queries per agent, bytes per broadcast, lock contention) in the RCA/PR before merging.

## Plans

All implementation plans live in `docs/plans/` (checked into the repo):

- `docs/plans/active/` — plans currently being implemented
- `docs/plans/completed/` — plans that have been shipped

Plan filenames should be kept in sync with the description of the task (kebab-case, e.g., `context-pointers.md`).

**Before modifying a file**, check `docs/plans/completed/` for plans that touched those files. Read them to understand implicit business functionality and ensure changes don't break it.

The `/deploy` skill automatically moves the related plan from `active/` to `completed/` before merging (if one exists).

## Temporal/Agent Patterns

- Workflows must be **deterministic** - no random, no wall-clock time, use `workflow.now()`
- Activities must be **idempotent** - safe on retry
- Activities may run on **any machine** — never rely on module-level shared state; add backend-API fallback (Claim Check pattern)
- Keep activity args small and serializable (IDs, names, flags) — resolve rich objects inside the activity; args accumulate across long workflows toward the 2MB payload limit
- Error handling: catch → format → yield error event → **don't raise**
- See `agents/tools/base.py` for ToolManager pattern

## Logging Guidelines

Always log these events (use `[Component]` prefix, include IDs, truncate payloads to 200 chars):

1. **HTTP requests** - method, path, body, response status, duration
2. **External calls** - Temporal, LLM, third-party APIs (request + response)
3. **Workflow events** - phase transitions, signals, completion/failure
4. **Tool execution** - tool name, input summary, output summary, duration
5. **DB mutations** - table, operation, record ID
6. **Errors** - message, stack, context (agentId, userId)

## Test Credentials (Dev)

- Supabase URL: `https://kzlurqihzaolhzsbkctf.supabase.co`
- Test phone: `+19729777432`
- Test OTP: `181818`
- Backend API Key: `AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=`
- If a test fails due to an invalid GPT auth token or invalid Claude auth token, retry with the token stored locally on the computer, or refetch the ones stored in the prod database — do not escalate before trying these.

**Query backend locally:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag="
```

## Database

- **ORM:** Prisma
- **RLS:** Enabled on all tables - users only see their own data
- **Realtime:** All realtime events use explicit HTTP broadcasts to Supabase Realtime (`POST /realtime/v1/api/broadcast`). `createMessage()` auto-broadcasts INSERT events; `updateAgentStatus()` auto-broadcasts UPDATE events. No DB triggers are involved.
- **Schema changes MUST ship a migration** — do NOT rely on `db push`. Local dev/setup (`scripts/run.sh`, `scripts/setup-db.sh`) run `prisma db push --accept-data-loss`, which silently conjures the DB from `schema.prisma`, so blackbox/local tests pass even with NO migration. Prod (`render.yaml`) runs `prisma migrate deploy`, which ONLY applies committed migration directories. A schema edit without a migration therefore works locally and **500s in prod** ("table/column does not exist" → e.g. every compute-token fetch fell to the paid waterfall on 2026-07-06). Correct path:
  1. Edit `back-end/prisma/schema.prisma`.
  2. Author the migration WITHOUT `prisma migrate dev` — its shadow DB replays the whole history including the squashed baseline (`00000000000000_init`), which contains Supabase RLS policies (`auth.uid()`) + `realtime.*` triggers that don't exist on a plain local Postgres shadow, so `migrate dev` fails. Instead diff your edited schema against the current local DB (no shadow):
     `mkdir -p prisma/migrations/$(date +%Y%m%d%H%M%S)_<desc> && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<that-dir>/migration.sql`
     (run BEFORE `db push`, while the local DB still reflects the old schema). Review the SQL, then `npx prisma db push` to apply locally. A loose `.sql` in the migrations root is IGNORED by `migrate deploy` — it MUST be `<timestamp>_<name>/migration.sql`.
  3. Commit the migration directory with the schema change. `src/tests/structural/migration-drift.test.ts` fails the build if `schema.prisma` has a model/column with no migration (both directions).
- **Migration history is a single squashed baseline** (`00000000000000_init`, from a `pg_dump` of prod on 2026-07-06 via `back-end/scripts/clean-baseline-dump.py`). It reproduces prod exactly — tables, enums, indexes (incl. the `pg_trgm` expression index), functions, triggers, and RLS policies — and existing DBs have it `migrate resolve --applied`. To re-baseline after major drift, re-run that script on a fresh `pg_dump` and re-resolve.
- **Query DB:** `npx tsx back-end/scripts/query-db.ts` (modify script as needed)

## Supabase Realtime Messages

All realtime and tool message types are defined in `front-end/src/lib/realtime-types.ts`.

## Rose Completions

In-process model racing (claudeAuth → OpenRouter waterfall). No external HTTP hop.

- `back-end/src/providers/rose/` - TS client (chat path: router/generator/supervisor)
- `agents/providers/rose/` - Python client (agent/browser-use path)
- `back-end/src/providers/rose/pools.ts` / `agents/providers/rose/pools.py` - Canonical pool registry (`rose-1-lite`, `rose-1-ultra`, `rose-1-browser-use`)
- `back-end/src/routes/agents.ts` - Agents API (create, poll, pause/resume)
- `back-end/src/middleware/hybridAuth.ts` - API key authentication

## Production Logs (Render)

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

### Prod health / latency dashboard (golden signals)

**"Is the backend slow right now?"** → one call: `cd back-end && npx tsx scripts/prod-health.ts`. It pulls Render request logs for a window and prints the four golden signals in a single view: **latency** (per-endpoint p50/p90/p99/max, routes templatized so `/api/agents/<uuid>` aggregates), **traffic** (req counts), **errors** (4xx/5xx per route + total), and **saturation** (slowest Prisma ops + a `EMAXCONN`/max-connection banner and deploy/instance state). Each endpoint's p90 is diffed against a rolling historical baseline the script persists to `scripts/.prod-health-history.jsonl` (gitignored) and appends to on every run — so `▲ +180%` flags a real regression vs. normal.

```bash
npx tsx scripts/prod-health.ts               # last 30m vs history
npx tsx scripts/prod-health.ts --window 2h   # wider window
npx tsx scripts/prod-health.ts --top 30      # more routes
npx tsx scripts/prod-health.ts --json        # machine-readable (for scripting/alerts)
npx tsx scripts/prod-health.ts --history     # inspect the stored baseline
npx tsx scripts/prod-health.ts --no-record   # don't append this run to history
```

Reads `RENDER_*` from `back-end/.env`; backs off on Render's log-API 429s. Typical culprit for a p99 spike with a pool-saturation banner: a Render deploy cutover (old+new instance Prisma pools exceed the Supabase pooler client cap → queries queue to Prisma's ~30s pool-acquisition timeout → `EMAXCONN`). Guarded since 2026-07: `providers/database.ts` derives `connection_limit` from the pooler budget (`POOLER_MAX_CLIENT_CONN`, set to 1000 on Render for the XL compute tier; code default 400) minus the fast-cache pool (`FAST_CACHE_DB_POOL`), cemented by `src/tests/structural/db-pool-invariant.test.ts`. DB is Supabase XL (4 dedicated cores, 16GB, `max_connections=240`, Supavisor `pool_size=60`).

## Production Env Vars

**You (Claude) own env-key management:** when you mint or rotate a credential, store it in every correct location — the relevant local `.env`, the matching prod surface(s) below, AND the Codex-cloud `rose` environment — never leave a key only in chat.

- **Render backend:** read `cd back-end && source .env && curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars?limit=100"`; set `cd back-end && source .env && curl -s -X PUT -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/KEY" -d '{"value":"VALUE"}'`; MANDATORY: User Approval Needed to Write Env Vars.
- **Fly agents:** read `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets list -a navi-whisper-lux`; set `cd agents && source .env && FLY_API_TOKEN="$FLY_API_TOKEN" flyctl secrets set KEY=VALUE -a navi-whisper-lux`; MANDATORY: User Approval Needed to Write Env Vars.
- **Vercel frontend:** read `cd front-end && vercel env ls production`; set `cd front-end && vercel env add KEY production`; MANDATORY: User Approval Needed to Write Env Vars.
- **Supabase functions:** read `cd agents && source .env && supabase secrets list --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; set `cd agents && source .env && supabase secrets set KEY=VALUE --project-ref "${SUPABASE_PROJECT_REF:-kzlurqihzaolhzsbkctf}"`; MANDATORY: User Approval Needed to Write Env Vars.
- **Codex-cloud `rose` environment:** the cloud sandbox env that mirrors backend secrets. Every key set on Render must also be mirrored here (and vice-versa). Set via the Codex cloud environment settings UI. MANDATORY: User Approval Needed to Write Env Vars.

## Autonomous Agent Testing

When testing agent features (new tools, explore agent, spawn_agent, etc.), follow this loop:

**1. Look up the real user ID:**

```bash
cd back-end && npx tsx scripts/dump-sms-context.ts  # userId for phone +19729777432
```

Real user ID: `1f85ff25-6e29-4c1b-8739-f917bd101a30` (Andy Prevalsky)

**2. Create an agent:**

```bash
curl -s -X POST "http://localhost:3001/api/agents" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" \
  -H "Content-Type: application/json" \
  -d '{"goal": "...", "start_phase": "plan"}'
```

Use `"start_phase": "plan"` to bypass chat mode and go directly into the Temporal workflow (plan → execute).
Use `"start_phase": "execute"` to skip planning too. Omit `start_phase` for normal chat mode.

**3. Poll messages every 10 seconds via GET agent detail:**

```bash
curl -s "http://localhost:3001/api/agents/{agent_id}" \
  -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
  -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"
```

Messages are in the response under `.messages[]`. Each message has `role`, `message`, and `metadata` (JSON with `toolName`, `toolStatus`, `title`, etc.).

**4. On ANY unexpected behavior, IMMEDIATELY follow this strict sequence (no exceptions):**

```
Step 1: DELETE the agent (stop bleeding tokens)
   curl -s -X DELETE "http://localhost:3001/api/agents/{agent_id}" \
     -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
     -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30"

Step 2: KILL the run script (stop all services)
   pkill -f worker.py; pkill -f "npx tsx watch"; pkill -f "npx vite"; pkill -f electron
   lsof -ti :3001 | xargs kill -9  # force-free the port if needed

Step 3: READ logs and DIAGNOSE
   - Read agents/navi-worker-log.txt for tracebacks/errors
   - Query DB if needed to get raw message data
   - Identify the ROOT CAUSE before writing any code

Step 4: FIX the root cause in code

Step 5: RESTART the run script (resets log files, picks up code changes)
   CONDUCTOR_PORT=3001 CONDUCTOR_WORKSPACE_NAME=managua-v1 bash scripts/run.sh
   Wait for "Worker started, waiting for tasks..." in the log

Step 6: Create a NEW agent and go back to step 3 (poll messages)
```

**CRITICAL: Do NOT skip steps or reorder them.** Especially:

- Do NOT continue polling a failed agent — delete it FIRST
- Do NOT make fixes without killing the run script FIRST (workers don't hot-reload)
- Do NOT restart the run script without reading logs FIRST (you'll just hit the same error)

**Key gotchas:**

- Temporal workers don't hot-reload — must kill and restart after code changes
- Old agents can't resume after code changes (Temporal nondeterminism error) — always create fresh
- The `run.sh` script sets `TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME` which overrides `back-end/.env`
- `spawn_agent.py` imports MUST be at module level (not lazy inside methods) because it runs inside Temporal's workflow sandbox. Lazy imports trigger `threading.Lock` errors.

## LLM Call Map

Every LLM call in the agent pipeline, ordered by execution flow.

### Agent Pipeline (agents/, runs inside Temporal)

| #   | Call Site                                                         | Model       | claudeAuth | Forces Ultra | Context Composition                                                                                                   | Est. Tokens |
| --- | ----------------------------------------------------------------- | ----------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| A1  | **Main Loop (PLAN)** `loop/run_agent.py` → `call_llm_activity`    | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 4 PLAN tool schemas (500t) + conversation + blueprints          | 3-20k       |
| A2  | **Planner LLM** `helpers/llm.py:call_planner_llm_activity`        | agent.model | YES        | no           | `build_planner_system_prompt` (3k) + user_context + conversation. **skip_cache=True**                                 | 5-15k       |
| A3  | **Verifier (PLAN)** `helpers/llm.py:check_progress`               | agent.model | YES        | no           | `build_verifier_prompt` (500t) + full conversation (USER+TOOL only, no SYSTEM/ASSISTANT)                              | 3-40k       |
| A4  | **Main Loop (EXECUTE)** `loop/run_agent.py` → `call_llm_activity` | agent.model | YES        | no           | `build_system_prompt` (2k) + user_context (200-15k) + 6 EXECUTE tool schemas (800t) + full conversation + DAG results | 5-80k       |
| A5  | **Verifier (EXECUTE)** `helpers/llm.py:check_progress`            | agent.model | YES        | no           | Same as A3 but with execute-phase conversation                                                                        | 5-80k       |

### Sub-Agent LLM Calls (spawned from EXECUTE phase)

| #   | Call Site                                                                             | Model        | claudeAuth | Forces Ultra | Context Composition                                                                                                                                                 | Est. Tokens |
| --- | ------------------------------------------------------------------------------------- | ------------ | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| S1  | **Explore Agent** `tools/spawn_agent.py` → `run_agent`                                | rose-1-lite  | **NO**     | no           | `EXPLORE_AGENT_SYSTEM_PROMPT` (300t) + **network_metadata (2k contacts, 5-15k t)** + local_data_summary + 4 tools (web_search, web_fetch, grep, attempt_completion) | 2-25k       |
| S2  | **Browser Agent** `tools/spawn_browser_agent_v3.py` → `call_llm_structured_streaming` | agent.model  | YES        | no           | `build_browser_system_prompt` (400t) + step history + screenshots (multimodal, heavy)                                                                               | 5-30k       |
| S3  | **Sub-Agent** spawns full workflow (A1-A5 repeat)                                     | parent.model | YES        | no           | Inherits parent user_context (gatable via context_gates) + own conversation                                                                                         | recursive   |

### Tool-Level LLM Calls (inside activities)

| #   | Call Site                                                   | Model               | claudeAuth | Forces Ultra | Context Composition                                                    | Est. Tokens     |
| --- | ----------------------------------------------------------- | ------------------- | ---------- | ------------ | ---------------------------------------------------------------------- | --------------- |
| T1  | **message_person** `tools/message_person.py` → `call_llm`   | agent.model         | **NO**     | no           | system prompt with conversation history + person thread + user message | 1-5k            |
| T2  | **Deep Research** `tools/deep_research.py` → Perplexity API | sonar-deep-research | N/A        | N/A          | system prompt + query (separate provider, separate billing)            | ~500 in, 8k out |

### claudeAuth Flow

- User's Claude OAuth token fetched at workflow start (`fetch_claude_max_token_activity`)
- Passed to Rose completions endpoint as `claude_token` param
- Rose routes directly to Anthropic API, skipping racing ($0 cost to Rose)
- Detected in response: `actual_model` ending with `-claude` suffix (e.g. `claude-sonnet-4-6-claude`)
- Refreshed before EXECUTE phase in case it expired during PLAN

### Context Gates per LLM Call

Each LLM call site, the context chunks it receives, and which `context_gates` key controls each chunk.

**Gate keys:** `user_profile`, `authenticated_sessions`, `integrations`, `recent_communications`, `network`, `custom_system_prompt`, `shared_files`

| LLM Call              | Context Chunk                                 | Gate Key                 | Est. Tokens | Notes                                           |
| --------------------- | --------------------------------------------- | ------------------------ | ----------- | ----------------------------------------------- |
| **A1/A4 Main Loop**   | user profile (name, phone, address)           | `user_profile`           | 50-100      | Via `get_user_context` → `build_system_prompt`  |
|                       | authenticated browser sessions                | `authenticated_sessions` | 20-50       |                                                 |
|                       | connected integrations (Gmail)                | `integrations`           | 20-30       |                                                 |
|                       | 200 recent messages (24h)                     | `recent_communications`  | 2-10k       | **Heaviest chunk**                              |
|                       | 2000 contacts network                         | `network`                | 5-15k       | **Heaviest chunk**                              |
|                       | custom system prompt                          | `custom_system_prompt`   | 0-500       | User personality injection                      |
|                       | file attachment resolution                    | `shared_files`           | variable    | Base64 images, text files                       |
|                       | system prompt (identity, phase, tools, rules) | _always on_              | 2-3k        | `build_system_prompt`                           |
|                       | conversation history                          | _always on_              | 1-50k       | Grows per iteration                             |
|                       | blueprints                                    | _always on_              | 0-2k        | Iteration 1 only                                |
| **A2 Planner**        | user_context (pre-gated)                      | _inherits parent gates_  | 0-15k       | Same gates as A1                                |
|                       | planner system prompt                         | _always on_              | 3k          | `build_planner_system_prompt`                   |
|                       | conversation history                          | _always on_              | 1-10k       |                                                 |
| **A3/A5 Verifier**    | verifier system prompt                        | _always on_              | 500         | `build_verifier_prompt`                         |
|                       | full conversation (USER+TOOL)                 | _always on_              | 3-80k       | No gates, no truncation                         |
| **S1 Explore**        | 500-contact network metadata                  | `network`                | 5-15k       | Via `fetch_full_network_metadata`               |
|                       | local message thread summary                  | `recent_communications`  | 0-2k        | Via `fetch_local_data_summary`                  |
|                       | explore system prompt                         | _always on_              | 300         | `EXPLORE_AGENT_SYSTEM_PROMPT`                   |
|                       | 4 tool schemas                                | _always on_              | 400         | web_search, web_fetch, grep, attempt_completion |
| **S2 Browser**        | browser system prompt                         | _always on_              | 400         | `build_browser_system_prompt`                   |
|                       | step history + screenshots                    | _always on_              | 5-30k       | No user context, no gates                       |
| **S3 Sub-Agent**      | _all chunks from A1_                          | _inherits parent gates_  | recursive   | Gates set by parent's `spawn_agent` call        |
| **T1 message_person** | cross-contact voice sample                    | `recent_communications`  | 1-5k        | `fetch_recent_messages_activity`                |
|                       | 1-on-1 thread with person                     | _always on_              | 0-3k        | Always needed for context                       |
|                       | Exa person enrichment                         | _always on_              | 0-1k        | Always needed for personalization               |
| **T2 Deep Research**  | system prompt + query                         | _always on_              | ~500        | Perplexity, separate billing                    |

### Remaining Waste (not gatable)

1. **A3/A5 Verifier** - Gets full conversation with no truncation. On long runs (20+ iterations) this balloons to 40-80k. Not yet gated.
2. **T1 message_person** - `call_llm` doesn't pass `claude_token`. Small per-call cost.
3. **Schema gen** (`setResponseSchema.ts`) - Forces Rose Ultra for a simple task. Rose Lite would suffice.

## CodeRabbit Review

PRs are reviewed by CodeRabbit (`.coderabbit.yaml`). After creating a PR:

```
1. Push branch + create PR
2. Poll check status via `gh pr checks <N> --json name,state`
   - Wait for "CodeRabbit" check to reach SUCCESS (poll every 30s)
3. Read the review:
   - `gh api repos/<owner/repo>/pulls/<N>/reviews` → bot reviews
   - `gh api repos/<owner/repo>/pulls/<N>/comments` → inline comments
4. Fix critical/major issues from CodeRabbit comments, push, go to step 2
5. Skip trivial nitpicks
```

## Ralph Instructions

- If the next step is to check a log file, make sure to call the tool. NEVER ask the user to check a log file for you.
