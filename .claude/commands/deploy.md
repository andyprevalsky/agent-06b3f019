---
description: "Push current branch, wait for PR review to pass, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, wait for CodeRabbit review, merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

---

# Step 0: Capture original Conductor workspace title

Before running tests or creating/updating a PR, capture the current Conductor workspace title so it can be restored after merge (the deploy flow mutates `pr_title_locked` to the PR title; without this capture the pre-deploy title is lost):

```bash
WORKSPACE_DIR="$(basename "$PWD")"
ORIGINAL_WORKSPACE_TITLE="$(sqlite3 "$HOME/Library/Application Support/com.conductor.app/conductor.db" \
  "SELECT pr_title FROM workspaces WHERE directory_name = '$WORKSPACE_DIR' LIMIT 1;")"
echo "ORIGINAL_WORKSPACE_TITLE=$ORIGINAL_WORKSPACE_TITLE"
```

If `ORIGINAL_WORKSPACE_TITLE` is empty, continue deploy but skip the final Step 14a rename.

---

# Phase 1: Test Loop

**ABSOLUTE RULE: 100% of tests must pass before proceeding to Phase 2. There are ZERO exceptions.** "Pre-existing failure", "not related to my changes", "performance issue", "local resource contention", "flaky test" — NONE of these are valid excuses. If a test fails, you fix it or you stop and ask the user. You NEVER skip, rationalize, or proceed with failing tests. A deploy with failing tests is a critical failure on your part.

**You must fix ALL failing tests, even if they are not caused by the changes in this branch.** The deploy flow is a gate — it guarantees that main is always green. If a test was already broken before your branch, that is now your responsibility to fix before merging. This includes infrastructure issues, flaky tests, timeout tuning, missing credentials, third-party integration problems, and anything else. The bar is simple: every test passes, or you don't merge.

Run all checks locally. If any step fails, fix the issue and re-run that step. If fixing required code changes, re-run the entire Test Loop from the top.

## Test Report Tracking

As you run each step in Phase 1, track the results in a `TEST_REPORT` variable. For each step, record:

- The step name
- Pass/fail status
- A brief summary of the output (e.g., "0 errors", "3 files formatted", "5/5 benchmarks passed")

Build the report as a markdown table:

```
| Step | Status | Summary |
|------|--------|---------|
| Prettier | ✅ Pass | 3 files formatted |
| ESLint | ✅ Pass | 0 errors |
| TypeScript | ✅ Pass | 0 errors |
| Structural Tests | ✅ Pass | All invariants hold |
| Blackbox API Tests | ✅ Pass | 12/12 tests passed |
| Smoke Benchmarks | ✅ Pass | 5/5 passed, $0.42 total cost |
```

Carry this report forward into Phase 2 for use in the commit message and PR body.

## Step 0: Change detection + execution plan

All Phase 1 commands run from the repo root. Compute changed paths once and derive skip flags:

```bash
CHANGED=$(git diff --name-only main...HEAD)
CHANGED_TS=$(echo "$CHANGED" | grep -E '^back-end/src/.*\.ts$' | sed 's|^back-end/||' || true)
CHANGED_BACKEND=$(echo "$CHANGED" | grep -E '^back-end/' || true)
CHANGED_AGENTS=$(echo "$CHANGED" | grep -E '^agents/' || true)
CHANGED_RESEARCH=$(echo "$CHANGED" | grep -E '^research/' || true)
CHANGED_FRONTEND=$(echo "$CHANGED" | grep -E '^front-end/' || true)
CHANGED_MAC_APP=$(echo "$CHANGED" | grep -E '^mac-app/' || true)
CHANGED_RUNTIME_SURFACE=$([ -n "$CHANGED_BACKEND$CHANGED_AGENTS$CHANGED_RESEARCH" ] && echo "yes" || echo "")
```

## Step 0p: Prompt human-approval guard (no skip — always runs)

Prompt modifications are high-risk behavior changes. **Any prompt modification MUST be approved by a human before deploy proceeds.** This includes system prompts, tool prompts, agent/skill instructions, `CLAUDE.md`, `.claude/commands/*.md`, prompt template files, strategy overrides, and prompt-related diff hunks.

Run the guard without the approval flag first:

```bash
bash scripts/check-prompt-human-approval.sh
```

If it passes, record `Prompt Human Approval Guard | Pass | no prompt edits detected` in `TEST_REPORT`.

If it fails, stop and ask the human to review the listed prompt modifications. Do not infer approval from silence, prior discussion, or the fact that the branch exists.

Human approval is scoped only to the prompt diff that exists when approval is requested. If any prompt, instruction, command, skill, or prompt-related file changes later — including changes made to fix tests or smoke benchmarks — re-run the guard without the approval flag, show the new prompt diff, and wait for fresh explicit approval before continuing.

After the human explicitly approves the current prompt changes, rerun the guard with the mandatory flag:

```bash
bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) may satisfy the guard. Do not pass it until explicit human approval has been retrieved in this deploy flow for the current prompt diff. Record `Prompt Human Approval Guard | Pass | human approval retrieved for prompt edits` in `TEST_REPORT`.

**Execution model for Steps 1–4a (run in this order):**

1. **Prompt approval gate** (read-only, always first): Step 0p. If prompt edits are detected, stop until a human approves them, then rerun Step 0p with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change prompt/instruction files, return to Step 0p without the flag and request fresh approval for those additional prompt changes.
2. **Sequential mutators** (they write files — cannot parallelize): Step 1 (`prettier --write`) → Step 2a (`eslint --fix`) → Step 1r (`research fmt/lint --fix`, skip if `CHANGED_RESEARCH` is empty) → Step 1m (`mac-app format + lint --fix`, skip if `CHANGED_MAC_APP` is empty). Commit any resulting changes once.
3. **Parallel verifiers** (all read-only, independent — run in a single message with multiple Bash tool calls):
   - Step 2b: `eslint` verify (0 errors)
   - Step 3: `tsc --noEmit`
   - Step 4: structural tests (skip if `CHANGED_TS` is empty)
   - Step 4a: back-end coverage (skip if `CHANGED_BACKEND` is empty)
   - Step 4b: front-end coverage (skip if `CHANGED_FRONTEND` is empty)
   - Step 4m-lint: mac-app format:check + lint + type-check (skip if `CHANGED_MAC_APP` is empty)
   - Step 4m-coverage: mac-app coverage (skip if `CHANGED_MAC_APP` is empty)
   - Step 4m: mac-app blackbox (skip if `CHANGED_MAC_APP` is empty)
   - Step 4r: research lint + structural (skip if `CHANGED_RESEARCH` is empty)

If any verifier fails, fix and re-run the full Step 0 → verifier flow. Do not proceed until all verifiers are green.

## Step 1: Prettier format

If `$CHANGED_TS` is non-empty, format them:

```bash
cd back-end && npx prettier --write $CHANGED_TS
```

If any files were modified by this step, stage and commit them:

```bash
git add -p  # review changes
git commit -m "style: auto-format and lint fixes"
```

## Step 2: ESLint fix + verify

Using the same `$CHANGED_TS` from Step 1 (skip if empty):

**Step 2a (mutator — runs before the parallel verifier batch):**

```bash
cd back-end && npx eslint --fix $CHANGED_TS
```

**Step 2b (verifier — runs in parallel with Steps 3, 4, 4a):**

```bash
cd back-end && npx eslint $CHANGED_TS
```

If there are remaining errors, fix them manually. Loop until `npx eslint` reports 0 errors.

**CRITICAL: You must reach 0 errors across ALL files in `$CHANGED_TS`. "Pre-existing" or "this error was already on main" is NOT an excuse to skip it.** If a file is in the diff, you own every error in it. This includes `no-console`, `no-explicit-any`, `strict-boolean-expressions`, `max-lines`, and any other rule. Fix them all.

If any files were modified by this step, stage and commit them (can combine with Step 1's commit if both ran together).

## Step 3: TypeScript type check

```bash
cd back-end && npx tsc --noEmit
```

Catches type errors that ESLint misses (wrong argument types, missing properties, bad generics). Fix any errors before proceeding — pre-existing type errors in touched files are your responsibility.

## Step 4: Structural tests + fix

**Skip if `$CHANGED_TS` is empty** (structural invariants only apply to back-end TS changes).

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

This enforces architectural invariants across all domains: import direction, cross-domain isolation, provider/util boundaries, domain completeness, Prisma/Express encapsulation, and circular import detection.

If any invariant fails, fix the violation. The test output includes remediation guidance (e.g., "Move the needed logic to service.ts or extract to a provider.").

## Step 4a: Code coverage check (skip if no back-end/ changes)

```bash
cd back-end && npm run test:coverage
```

Coverage must meet the configured thresholds in `back-end/.c8rc.json`. If it fails, add tests to cover the gap before proceeding.

## Step 4b: Front-end code coverage check (skip if no front-end/ changes)

```bash
cd front-end && npm run test:coverage
```

Coverage must meet the thresholds configured in `front-end/vitest.config.ts` (`coverage.thresholds`). Thresholds ratchet toward a target of 80% — if the gate fails, add tests to cover the gap before proceeding. Never loosen the threshold.

## Step 4g: Agents code coverage check (skip if no agents/ changes)

```bash
cd agents && bash scripts/run-coverage.sh
```

Coverage must meet the `fail_under` threshold in `agents/pyproject.toml` (`[tool.coverage.report]`). Threshold ratchets toward a target of 80% — if the gate fails, add tests to cover the gap before proceeding. Never loosen the threshold.

## Step 1m: Mac-app format + lint auto-fix (skip if `$CHANGED_MAC_APP` is empty)

Sequential mutator — runs before the parallel verifier batch, same pattern as Step 1 (prettier) and Step 2a (eslint --fix) for the back-end.

```bash
cd mac-app && npm run format && npm run lint:fix
```

Commit any resulting changes (can combine with Step 1's commit).

## Step 4m-lint: Mac-app format:check + lint + type-check (skip if `$CHANGED_MAC_APP` is empty)

Parallel verifier. Enforces the same 0-error bar as back-end Step 2b — "pre-existing" violations in the mac-app files you touched are your responsibility.

```bash
cd mac-app && npm run format:check && npm run lint && npm run type-check
```

If any check fails, fix and re-run. `npm run lint` applies both base rules and the type-aware strict overlay defined by `STRICT_DOMAIN_FILES` in `mac-app/eslint.config.mjs` (max-lines, max-lines-per-function, no-floating-promises, strict-boolean-expressions, etc.).

## Step 4m-coverage: Mac-app code coverage check (skip if `$CHANGED_MAC_APP` is empty)

```bash
cd mac-app && npm run test:coverage
```

Coverage must meet the thresholds configured in `mac-app/vitest.config.ts` (`coverage.thresholds`). Thresholds ratchet toward a target of 80% — if the gate fails, add tests to cover the gap before proceeding. Never loosen the threshold.

## Step 4m: Mac-app blackbox tests (skip if `$CHANGED_MAC_APP` is empty)

The mac-app has its own vitest + MSW + jsdom blackbox suite covering every renderer and main-process domain (see `mac-app/tests/blackbox/`). Run the full suite:

```bash
cd mac-app && bash scripts/run-blackbox-tests.sh
```

**ALL domains must pass — 0 failures.** Same rule as backend blackbox (Step 5a): "pre-existing" is not an excuse, fix every failure. The runner writes artifacts to `mac-app/.context/test-runs/<run-id>/` with a `manifest.json` + `runner.log` for diagnosis.

If the failure is renderer-only (jsdom + React), check `mac-app/tests/blackbox/test-wrapper.tsx` and the relevant MSW handlers in `mac-app/tests/blackbox/msw/handlers.ts`. If it's main-process (Node + Electron stubs), check `mac-app/tests/blackbox/electron-stubs.ts` and `mac-app/tests/blackbox/fetch-capture.ts`.

## Step 4r: Research lint + structural (skip if `$CHANGED_RESEARCH` is empty)

If the diff touches `research/`, run the research-side check harness. It enforces fmt/lint (base + strict overlay), structural invariants (max 300 lines per file, 80 per function), and Python ruff.

```bash
cd research && bash scripts/lint-check.sh
```

If anything fails, re-run with `--fix` to auto-apply format/lint fixes, then re-run without `--fix` to verify:

```bash
cd research && bash scripts/lint-check.sh --fix
cd research && bash scripts/lint-check.sh
```

Commit any auto-fix changes before proceeding. "Pre-existing" violations in touched files are your responsibility — the same 0-failure rule from Steps 2/3/4 applies here.

## Step 4c: Credential health check (no skip — always runs)

Before spinning up services or spending money on smoke benchmarks, validate every external credential (E2B, Steel, Parallel.ai, Anthropic, OpenRouter, Supabase). This runs standalone against real provider endpoints — no local backend needed. Finishes in ~3s and fails fast on 401/402/403.

```bash
cd back-end && npx tsx src/tests/blackbox/integration-health.blackbox.ts
```

**If ANY credential is rejected** the error message names the exact env var to refresh and the provider dashboard URL. Escalate to the user immediately — do NOT proceed to Step 5. Refreshing credentials is a human task; working around auth failures in code is forbidden.

This same file is also part of the full blackbox suite (Step 5a), so it will run again there when the backend-change path fires. Running it twice is harmless (~3s).

## Step 4d: Push PR early, start CodeRabbit in parallel with runtime tests

Static checks (1–4a) are now green. **Do not wait for Steps 5–6 to finish before pushing** — CodeRabbit review is usually the longest idle block in the whole flow (~5–15 min). Push the branch and open the PR **now**, so CodeRabbit reviews while the local smoke/blackbox runs happen.

1. Commit any uncommitted changes from Phase 1a (prettier/eslint fixes, coverage-driven test additions), using the test-report commit format from Step 7.
2. If on `main`, create a new branch; push with `-u`:
   ```bash
   git push -u origin $(git branch --show-current)
   ```
3. Create the PR now (same body/title format as Step 8). Persist `pr_title_locked` as described in Step 8.
4. **In parallel**, proceed to Steps 5, 5a, 6 (runtime tests) AND begin Step 9 (CodeRabbit wait). Do not serialize them. Both must be green before merging.

**If runtime tests (5/5a/6) fail** after the PR is already open: fix the issue, push the fix commit, and restart the Test Loop from Step 0. The new push re-arms CodeRabbit automatically — Step 9's poll-until-re-armed logic handles that correctly.

**Consequence for Phase 2:** by the time you reach Step 7/8, the push and PR already exist. Treat Steps 7 and 8 as "verify already done" unless an earlier test-loop iteration failed and forced a restart.

## Step 5: Spin up local services

**Step 5.0 (MANDATORY pre-flight garbage collection):** before spinning up anything, kill any stale run.sh trees + orphaned backend/worker/supabase processes from prior aborted runs in this worktree. Orphans subscribe to the same Temporal task queue the new run will use and will silently steal work from smoke tasks.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/list-services.sh           # inspect what's running (optional, informational)
bash scripts/kill-services.sh           # kill the whole tree; preserves DB container + volume
```

`scripts/kill-services.sh` is worktree-scoped (uses `$PWD` as the filter), walks descendants via `pgrep -P`, SIGTERMs then SIGKILLs survivors, and deliberately leaves the Postgres container intact. Re-run it any time you need a clean slate — it is idempotent.

Spin up the local stack through `scripts/run.sh --benchmark`. In benchmark mode, `run.sh` starts only the services smoke tests need (`back-end`, `agents`, `research`) and skips `front-end` + `mac-app`. When this command is used inside Conductor, `run.sh` already derives the backend, worker-health, and research ports from `CONDUCTOR_PORT`, so do not hard-code or pass a separate smoke-test port to the benchmark harness.

```bash
# Conductor provides the base port; run.sh fans out backend/frontend/health/research from it.
if [ -z "$CONDUCTOR_PORT" ]; then
  echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
  exit 1
fi

export SMOKE_BASE_URL="http://localhost:$CONDUCTOR_PORT"
export SMOKE_HEALTH_URL="http://localhost:$((CONDUCTOR_PORT + 2))"
export SMOKE_RESEARCH_URL="http://localhost:$((CONDUCTOR_PORT + 3))"

cd "$(git rev-parse --show-toplevel)"
```

**CRITICAL: Start the DB container BEFORE `run.sh` so that `run.sh` treats it as pre-existing and won't stop it on cleanup.** `run.sh` has an EXIT trap that stops all services it started — including the DB container. By pre-starting the DB, `run.sh` sees it as already running and skips DB cleanup, which prevents the DB from dying if `run.sh` exits for any reason (signal, child process exit, timeout, etc.).

```bash
# Step 1: Ensure DB is running BEFORE run.sh starts (so run.sh won't own/stop it)
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
LOCAL_DB_PORT=$((CONDUCTOR_PORT + 10))

if ! docker ps --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  if docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    docker start "$DB_CONTAINER" >/dev/null
  else
    docker run -d --name "$DB_CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=victoria \
      -p "$LOCAL_DB_PORT:5432" -v "victoria-pgdata-${CONDUCTOR_WORKSPACE_NAME:-local}:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null
    # Wait + push schema + seed for fresh containers
    for i in $(seq 1 30); do docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
    (cd back-end && DATABASE_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria" \
      DIRECT_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria" \
      npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3)
    (cd back-end && DATABASE_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria" \
      DIRECT_URL="postgresql://postgres:postgres@localhost:$LOCAL_DB_PORT/victoria" \
      npx tsx scripts/seed-local.ts)
  fi
  for i in $(seq 1 30); do docker exec "$DB_CONTAINER" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
fi
echo "DB pre-started: $DB_CONTAINER on port $LOCAL_DB_PORT"
```

```bash
# Step 2: Launch run.sh using the Bash tool's run_in_background parameter.
# run.sh will detect the DB as already-running and won't stop it on cleanup.
# Use run_in_background=true for this command:
DISABLE_GMAIL_SYNC=1 bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
```

Then, in separate (foreground) Bash calls, wait for each service:

```bash
# Wait for backend, worker health, and research to be ready
for i in $(seq 1 60); do curl -s "$SMOKE_BASE_URL/health" > /dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 60); do curl -s "$SMOKE_HEALTH_URL/health" > /dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 60); do curl -s "$SMOKE_RESEARCH_URL/functions/v1/completions" > /dev/null 2>&1 && break; sleep 2; done
```

**Also start the frontend dev server** (required by Step 6b semantic tests). `run.sh --benchmark` intentionally skips the front-end, so launch it as a sibling background process:

```bash
# Start front-end dev server in a separate background process (needed for semantic tests).
# run_in_background=true for this command:
(cd front-end && VITE_PORT=$((CONDUCTOR_PORT + 1)) npm run dev > frontend-logs.log 2>&1)
```

```bash
export SMOKE_FRONTEND_URL="http://localhost:$((CONDUCTOR_PORT + 1))"
for i in $(seq 1 60); do curl -sf "$SMOKE_FRONTEND_URL" > /dev/null 2>&1 && break; sleep 2; done
```

**Teardown (MANDATORY):** after Step 6 finishes (pass OR fail), and any time you abort Step 5/6 mid-way, you MUST tear the stack down before moving on. Skipping this leaves zombie run.sh + grandchildren that (a) subscribe to the Temporal queue and poison the next smoke run, and (b) leak ports, RAM, and worker slots across `/deploy` invocations.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/kill-services.sh                    # kills run.sh tree, preserves DB
(cd research/supabase && supabase stop 2>/dev/null) || true   # stop supabase compose stack
```

`kill-services.sh` is a superset of the old `pkill -f "scripts/run.sh --benchmark"` approach: `pkill` only signals bash wrappers, so detached node/python grandchildren survive (the real root cause of the zombie-run.sh problem). `kill-services.sh` walks descendants explicitly. Use `scripts/teardown.sh` instead if you also want to delete the DB container + volume (destructive).

## Step 5a: Blackbox API tests + fix

**Skip if `$CHANGED_BACKEND` is empty** (blackbox tests only exercise back-end routes; front-end/mac-app-only PRs don't need them).

With the backend running from Step 5:

```bash
cd back-end
BLACKBOX_TEST_USE_EXISTING_BACKEND=1 TEST_BASE_URL=$SMOKE_BASE_URL bash scripts/run-blackbox-tests.sh
```

**ALL domains must pass — 0 failures.** If ANY domain fails, you must fix it before proceeding, even if the failing domain was not modified in this PR. "Pre-existing" is not an excuse. Fix it, re-run, get 100%. If you cannot fix a failure, STOP and escalate to the user — do NOT proceed to Phase 2.

**ESCALATE IMMEDIATELY on third-party credit/billing errors.** If any test fails with "insufficient credits", "402", "quota exceeded", or similar billing errors from external providers (OpenRouter, OpenAI, E2B, Twilio, etc.), STOP and tell the user immediately. Do NOT try to fix this in code (e.g., accepting 500s). The user needs to add credits to the provider account.

## Step 6: Smoke benchmarks + fix

### When smoke can be skipped

Smoke benchmarks exercise the full agent runtime (backend API → Temporal → worker activities → LLM calls → research completions). Skip them **only** when the PR diff cannot possibly affect that runtime. Confirm by running `git diff --name-only main...HEAD` and checking every path against the table below.

**SAFE TO SKIP** when the diff is limited to paths that don't ship or don't affect agent behavior:

| Path pattern                                                                                                   | Why safe                                                                   |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `**/tests/**` (including structural, blackbox, e2e, semantic)                                                  | Test code doesn't run in prod                                              |
| `**/benchmarks/**`                                                                                             | Benchmarks don't run in prod                                               |
| `docs/**`, `**/*.md`, `**/README*`, `**/CLAUDE.md`                                                             | Documentation only                                                         |
| `front-end/**`                                                                                                 | Smoke doesn't exercise the front-end path (covered by FE blackbox + build) |
| `mac-app/**`                                                                                                   | Smoke doesn't exercise mac-app                                             |
| `.claude/**`                                                                                                   | Agent/skill config; local tooling only                                     |
| `.coderabbit.yaml`, `.eslintrc*`, `eslint.config.*`, `.prettier*`, `*.test.config.*`, `vitest.config.*`        | Lint/format/test-runner config only                                        |
| `scripts/test.sh`, `scripts/run-*-tests.sh`, `**/scripts/run_blackbox_tests.py`                                | Test harness — doesn't change runtime                                      |
| `.github/workflows/*.yml` (CI config only)                                                                     | Deploy/CI config — doesn't change app code                                 |
| `refactor.md`, `conductor.json` (unless it changes service wiring)                                             | Tooling config                                                             |
| Lock files (`package-lock.json`, `pnpm-lock.yaml`, `uv.lock`) **with no `package.json`/`pyproject.toml` diff** | Pure lock churn                                                            |

**MUST RUN SMOKE** when the diff touches any of these (even one line):

| Key path                                                                             | Why it needs smoke                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `back-end/src/**/*.ts` (excluding `back-end/src/tests/**`)                           | Any API, middleware, service, route, provider change can affect the request path smoke hits  |
| `back-end/prisma/schema.prisma`, `back-end/prisma/migrations/**`                     | DB schema / realtime triggers — blast radius across every DB read/write                      |
| `agents/activities/**`, `agents/helpers/**`, `agents/loop/**`, `agents/workflows/**` | Core Temporal runtime — workflow/activity code paths executed by every benchmark             |
| `agents/tools/**`, `agents/domains/**`, `agents/browser_tools/**`                    | Tool implementations smoke depends on (spawn_sub_agents, parallel-tool-calls, browser-smoke) |
| `agents/worker.py`, `agents/config.py`, `agents/health_server.py`                    | Composition root / worker wiring                                                             |
| `agents/requirements.txt`, `agents/pyproject.toml` (non-lint sections)               | Runtime dep changes can break imports at startup                                             |
| `agents/Dockerfile`, `agents/fly.toml`, `agents/deploy.sh`                           | Worker deployment shape                                                                      |
| `research/supabase/functions/**`                                                     | Rose completions endpoint — all A* / S* LLM calls route through here                         |
| `scripts/run.sh`                                                                     | Service startup and env wiring that smoke depends on                                         |
| `back-end/.env.example` **when it adds a new required env var**                      | Runtime config contract change                                                               |

**Tie-breaker rule:** if a path touches both safe and must-run buckets, treat the diff as must-run. When in doubt, run smoke — or ask the user.

When skipping, record it explicitly in the Test Report:

```
| Smoke Benchmarks | ⏭️ Skipped | Diff is test-infra only (paths: <list>) — no runtime impact |
```

### Running smoke

With the local stack from Step 5 still running, run the smoke benchmark suite against that local backend. Do not pass a hard-coded localhost port to the benchmark command; point it at the same base URL `run.sh` is already serving.

```bash
# Run smoke benchmarks against local backend.
# TEMPORAL_TASK_QUEUE must match the queue run.sh's worker listens on.
# ALLOW_TEMPORAL_CLEANUP=true lets the benchmark pre-flight terminate stale workflows
# from previous runs on Temporal Cloud (otherwise cleanup is skipped for non-local Temporal).
cd "$(git rev-parse --show-toplevel)/agents" && source venv/bin/activate
TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME ALLOW_TEMPORAL_CLEANUP=true python benchmarks/run_benchmark.py --suite smoke --port $CONDUCTOR_PORT --ci --parallel
```

This runs 5 e2e tests (chat-mode, spawn-sub-agents, parallel-tool-calls, claude-code-agent, browser-smoke) against the local backend + worker + research. The `--ci` flag exits non-zero on failure. The `--parallel` flag runs all 5 tasks concurrently.

Results are saved to `agents/benchmarks/runs/`. Report the pass rate and total cost to the user.

### Timeout history + bootstrap

Per-task timeouts are **dynamic** — derived from p95 × 1.5 of past passes in `agents/benchmarks/history/task_durations.jsonl` (tracked in git). `run_benchmark.py` refuses to run if any task has fewer than 5 passes in history.

**Two cases:**

1. **First run on a fresh checkout** (or any task shows `InsufficientHistoryError`): bootstrap the corpus with `--bootstrap`. This accepts the tasks.json `timeout_seconds` as a ceiling and still records passes. Run 5×:

   ```bash
   cd "$(git rev-parse --show-toplevel)/agents" && source venv/bin/activate
   for i in 1 2 3 4 5; do
     TEMPORAL_TASK_QUEUE=navi-agent-tasks-$CONDUCTOR_WORKSPACE_NAME ALLOW_TEMPORAL_CLEANUP=true \
       python benchmarks/run_benchmark.py --suite smoke --port $CONDUCTOR_PORT --ci --parallel --bootstrap
   done
   git add agents/benchmarks/history/task_durations.jsonl
   git commit -m "benchmarks: bootstrap smoke timeout history"
   ```

2. **Normal run** (history exists): the command at the top of Step 6 runs as-is, without `--bootstrap`. On success, passes auto-append to the JSONL.

**After Step 6 passes: stage, commit, AND PUSH the updated history** before Phase 2. The PR was already pushed in Step 4d, so this commit MUST be pushed too — otherwise it stays local-only and never reaches the PR head, so the merge (Step 12) silently drops the recorded durations:

```bash
if ! git diff --quiet -- agents/benchmarks/history/task_durations.jsonl; then
  git add agents/benchmarks/history/task_durations.jsonl
  git commit -m "benchmarks: record smoke pass durations"
  git push   # land it on the PR head so the merge includes it (the early Step 4d push is stale)
fi
```

The JSONL uses `merge=union` (`.gitattributes`) so parallel branches do not conflict on it.

### Monitoring agent progress during smoke tests

**Do NOT fire-and-forget.** While benchmarks run, actively monitor agent progress by polling each agent's detail endpoint (`GET /api/agents/{id}`) AND tailing the smoke log file.

**Universal background-task cadence (applies here AND to every background task in this repo):**

- **First 60 seconds:** poll every **10 seconds** (catches silent early deaths — 0-byte logs, missing-env crashes, queue-routing bugs)
- **After 60 seconds:** poll every **60 seconds**
- **Exit the monitor the instant the last task finishes** — do NOT keep sleeping out the interval. As soon as the completion signal is seen (exit code, "RESULTS:" line, PID no longer running), stop polling and move on.

At each poll, check:

- Agent status (ACTIVE, COMPLETED, FAILED, ERROR)
- Message count and latest messages
- Progress score
- Any error messages
- Background PID is still alive (`ps -p <pid>`) — a 0-byte log + dead PID means the task died silently

**If any agent shows signs of trouble** (stuck at 0 messages for 30s+, ERROR status, backend 500s in logs), immediately:

1. Kill ALL running benchmark agents (DELETE each agent)
2. Read logs (backend, worker, research) to diagnose
3. Fix the root cause
4. Re-run sequentially (without `--parallel`) to isolate failures

### Pass criteria

**ALL 5 smoke benchmarks must pass — 0 failures.** Timeouts, stalls, wrong tool usage, backend crashes, or any other failure mode must be diagnosed and fixed. You are expected to root-cause every failure and fix it in code. This is not optional — smoke failures are real bugs.

**Diagnosis process — MUST be delegated to a `general-purpose` sub-agent.**

Don't try to diagnose smoke failures inline in your own context — the diagnostic
output for a single failed agent is hundreds of KB across 3 log files, plus
multiple span-tree dumps, and burns the main context fast. Delegate, and ship a
fix that the main loop can verify.

**For each failed task, in a single message, spawn ONE `general-purpose` agent
per failed `agent_id`** (run them concurrently — they're independent). Hand
each agent the full failure context and tell it to do steps 1–4 end to end:

```
Agent({
  description: "Diagnose + fix <task-name> smoke failure",
  subagent_type: "general-purpose",
  prompt: """
Smoke task <task-name> just failed in /deploy. Agent ID: <agent_id>.
Failure reason from benchmark runner: <reason string from results JSON>.

Repo root: <abs path>. Backend at http://localhost:$CONDUCTOR_PORT.

Steps 1–5 — do them all, do not stop early:

1. Read the relevant log files (truncate aggressively as you go, keep only
   the windows around the failed agent_id):
   - back-end/backend-logs.log
   - agents/navi-worker-log.txt
   - research/research-logs.log

2. Run BOTH diagnostic summaries IN PARALLEL on the failed agent_id, then
   fully expand whichever one points at the smoking gun:
   - `cd agents && source venv/bin/activate && python benchmarks/agent_latency.py <agent_id>`
     — span-based waterfall: executive summary, top 10 slowest paths,
     slowest LLM calls, slowest backend HTTP, deduped errors. Best for
     "why was this slow/stalled."
   - `cd agents && source venv/bin/activate && python benchmarks/agent_logs.py <agent_id> --tree --diagnostics`
     — event-timeline tree across worker/backend/research/messages. Best
     for raw error context.
   - For full detail when the summary points at a layer:
     `agent_latency.py <agent_id> -v` for the full span tree, or
     `agent_logs.py <agent_id> --tree --source worker|backend|research|messages`
     for per-source raw events.
   - To compare cost/cache against a passing run:
     `python benchmarks/run_benchmark.py --compare <fail.json> <pass.json>`.

3. Identify the exact root cause: which agent-lifecycle phase, which LLM
   call site, which activity, or which backend route is failing. State it
   as a single sentence: "<phase> <component> at <file>:<line> fails
   because <X>."

4. Implement the fix in code. Real fixes only — no timeout bumps, no test
   weakening, no skipping. If the fix needs services restarted, note that
   in your final report.

5. Verify the fix is sane: re-run any structural/blackbox/lint check that
   covers the modified file(s). You do NOT re-run smoke — the parent loop
   does that next.

Final report (under 200 words):
- Root cause (1 sentence)
- Files modified + line ranges
- Whether worker/backend needs restart for the fix to take effect
- Any follow-up risks
"""
})
```

When all spawned agents return, **the main loop** restarts services as
instructed and re-runs smoke from the top. If the same task fails again with
a NEW failure mode, spawn a fresh diagnostic agent — never assume a previous
agent's fix was complete.

**Do not** read >5 KB of log content inline before delegating. Grep for the
exact agent_id, scan the result, then hand the agent_id off.

**NOT allowed when fixing smoke tests:**

- Changing the nature/intent of a test (e.g., weakening assertions, changing what the test validates)
- Changing timeouts without explicit user permission — instead, diagnose which parts of the agent lifecycle and LLM requests are causing the most latency, and reduce them precisely in a generalizable way that won't create downstream issues
- Skipping or disabling tests

**Escalation is ONLY for:**

- Third-party providers returning error codes that indicate the account is out of credits/funds (e.g., "insufficient credits", "402", "quota exceeded")
- Authentication/OAuth token errors (e.g., "401", "authentication failed", "credentials expired") — these require the user to re-authenticate or provide fresh tokens. Do NOT work around auth errors in code; escalate to the user to retrieve valid tokens.

Everything else — crashes, timeouts, stalls, resource contention, infra issues — is your job to fix.

If a benchmark fails due to local resource contention, try running fewer in parallel or running them sequentially — but you must still get all 5 passing.

### Cleanup: Delete smoke test agents

**This must happen BEFORE teardown** — the local backend must still be running to process DELETE requests.

If benchmarks **pass**: delete all agents created during the run, then teardown.

```bash
RESULTS_FILE=$(ls -t agents/benchmarks/runs/*.json 2>/dev/null | head -1)
if [ -n "$RESULTS_FILE" ]; then
  python3 -c "
import json
with open('$RESULTS_FILE') as f:
    data = json.load(f)
for r in data.get('task_results', []):
    aid = r.get('agent_id', '')
    if aid:
        print(aid)
" | while read aid; do
    curl -s -X DELETE "$SMOKE_BASE_URL/api/agents/$aid" \
      -H "X-API-Key: AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=" \
      -H "X-User-Id: 1f85ff25-6e29-4c1b-8739-f917bd101a30" > /dev/null
  done
fi
```

If benchmarks **fail**: do NOT delete agents yet — keep them alive for diagnosis. Diagnose and fix the issue first (see below), then delete agents, then teardown, then re-run from the top of the Test Loop.

**After cleanup (or after diagnosis on failure), run the teardown helper from Step 5.**

### Diagnosing failures

When any test or benchmark fails, check these local log files before making code changes:

| Service  | Log file                     | What to look for                                        |
| -------- | ---------------------------- | ------------------------------------------------------- |
| Backend  | `back-end/backend-logs.log`  | HTTP errors, Temporal client failures, DB errors        |
| Worker   | `agents/navi-worker-log.txt` | Workflow tracebacks, activity failures, LLM call errors |
| Research | `research/research-logs.log` | Edge function errors, rate limits, auth failures        |

For benchmark-specific diagnostics, run ALL three summaries in parallel — they answer different questions:

```bash
# "Why was this slow/stalled?" — span waterfall + top-10 bad paths
cd agents && python benchmarks/agent_latency.py <agent_id>

# "What errors happened where?" — event-timeline tree
cd agents && python benchmarks/agent_logs.py <agent_id> --tree --diagnostics

# "How much did this cost / cache?" — tree-wide token + cache breakdown
cd agents && python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>
```

Expand the relevant one: `agent_latency.py <agent_id> -v` for the full span tree, or `agent_logs.py <agent_id> --tree --source worker|backend|research|messages` for per-source raw events.

## Step 6b: Semantic tests + fix

Semantic tests exercise real user flows through Playwright/Chromium against the full local stack (backend + worker + research + **frontend**). They are the only gate that proves realtime broadcasts reach the UI and that the login path still works end-to-end.

**Skip criteria are the same as Step 6 (smoke).** If you ran smoke, you run semantic. If smoke was safely skipped per the "When smoke can be skipped" table, record semantic as skipped too with the same reason. **Never skip semantic tests unless smoke was also skipped.**

### Running semantic tests

With the full stack from Step 5 still running (backend, worker, research, **and frontend on `$SMOKE_FRONTEND_URL`**):

```bash
cd "$(git rev-parse --show-toplevel)"
BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash front-end/scripts/run-semantic-tests.sh
```

This runs every `.spec.ts` under `front-end/tests-e2e/` via headless Chromium. To run a single test:

```bash
BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash front-end/scripts/run-semantic-tests.sh login
```

If Chromium is missing, install once: `cd front-end && npx playwright install chromium`.

### Pass criteria

**ALL semantic tests must pass — 0 failures.** Per CLAUDE.md rule #15: if a semantic test fails, you diagnose and fix the root cause. "Flaky selector", "realtime broadcast didn't arrive", "timeout" — none of those are excuses. Fix the underlying issue.

### On failure

1. Read the failing invariant from the Playwright output. Trace artifacts land in `front-end/test-results/` and `front-end/playwright-report/` (video/trace are retained on failure).
2. Check `front-end/frontend-logs.log`, `back-end/backend-logs.log`, `agents/navi-worker-log.txt` for backend-side errors that correlate with the UI failure.
3. Fix the root cause in code.
4. Restart services (Step 5) and re-run the failed semantic test.

---

# ╔══════════════════════════════════════════════════════════════════════╗

# ║ HARD GATE — PHASE 2 BLOCKED ║

# ║ ║

# ║ Do NOT enter Phase 2 unless ALL of the following are true: ║

# ║ ║

# ║ 1. Prettier: 0 formatting changes remaining ║

# ║ 2. ESLint: 0 errors ║

# ║ 3. TypeScript: 0 errors ║

# ║ 4. Structural tests: 100% pass ║

# ║ 4a. Code coverage: meets thresholds in .c8rc.json ║

# ║ 4g. Agents code coverage: meets pyproject.toml threshold ║

# ║ 4c. Credential health: all integrations authenticate ║

# ║ 4m-coverage. Mac-app coverage: meets vitest thresholds ║

# ║ 4m. Mac-app blackbox: 100% pass (skip if no mac-app/ changes) ║

# ║ 5. Blackbox API tests: 100% pass (ALL domains) ║

# ║ 6. Smoke benchmarks: 5/5 pass — OR explicitly skipped per the ║

# ║ "When smoke can be skipped" table in Step 6 (diff must be ║

# ║ limited to safe paths; if ANY must-run path is touched, smoke ║

# ║ is required) ║

# ║ 6b. Semantic tests: 100% pass whenever smoke ran (skip together ║

# ║ with smoke — never skip one without the other) ║

# ║ ║

# ║ If ANY test has ANY failure, you are BLOCKED. ║

# ║ Fix it or escalate to the user. Do NOT proceed. ║

# ║ ║

# ║ INVALID EXCUSES (do NOT use these to justify proceeding): ║

# ║ - "Pre-existing" / "not related to my changes" ║

# ║ - "Infrastructure issue" / "flaky" / "resource contention" ║

# ║ - "The code changes don't touch agent/Temporal code" (check the ║

# ║ Step 6 table — back-end/ and research/ changes ALSO require ║

# ║ smoke, not just agents/) ║

# ║ - "Expired tokens" (re-run seed script or escalate to user) ║

# ║ - "Temporal connectivity" (restart workers, fix it) ║

# ║ - "Agents timing out" (investigate and fix) ║

# ║ ║

# ║ Merging or creating a PR with known failures is a CRITICAL ║

# ║ ERROR. The user has explicitly and repeatedly stated this. ║

# ╚══════════════════════════════════════════════════════════════════════╝

# Phase 2: CI/CD Loop

## Step 7: Prepare the branch

1. Check `git status` for uncommitted changes. If there are any, stage and commit them with a message that includes the test report:

   ```bash
   git commit -m "$(cat <<'EOF'
   <concise description of changes>

   ## Test Report

   | Step | Status | Summary |
   |------|--------|---------|
   | ... test results from Phase 1 ... |
   EOF
   )"
   ```

2. If on `main`, create a new branch first:
   ```bash
   git checkout -b <descriptive-branch-name>
   ```
3. Push the branch:
   ```bash
   git push -u origin $(git branch --show-current)
   ```

## Step 8: Create PR

Create a PR targeting `main`:

```bash
PR_TITLE="<concise title>"
gh pr create --title "$PR_TITLE" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points describing the changes>

## Test Report

| Step | Status | Summary |
|------|--------|---------|
| ... test results from Phase 1 ... |

<details>
<summary>Test output details</summary>

Include relevant output snippets from each test step — e.g., ESLint summary, structural test output, blackbox test pass/fail counts, smoke benchmark results and costs. Truncate verbose output but keep enough to diagnose any issues.

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If a PR already exists for this branch, skip creation and read its title:

```bash
PR_TITLE=$(gh pr view --json title --jq '.title')
```

**Persist the PR title to the Conductor workspace (hard record bound to the worktree):**

Store the title in the `pr_title_locked` column — this column is ours and is never touched by Conductor's auto-sync (which only writes to `pr_title` based on branch name). SQLite is dynamically typed, so the INTEGER column accepts text.

```bash
# Escape single quotes for SQL
ESCAPED_TITLE=$(printf "%s" "$PR_TITLE" | sed "s/'/''/g")
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title_locked = '$ESCAPED_TITLE' WHERE directory_name = '$(basename "$PWD")'"
```

From this point on, Steps 9–13 should read the PR title from this record (rather than querying GitHub) so the workspace and the deploy flow agree on what's shipping:

```bash
PR_TITLE=$(sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "SELECT pr_title_locked FROM workspaces WHERE directory_name = '$(basename "$PWD")'")
```

## Step 9: Wait for code review

**CRITICAL — avoid the stale-check race.** `gh pr checks --watch` watches a single check entry. If CodeRabbit hasn't yet flipped the check to PENDING for your newest push, `--watch` will see the prior SUCCESS from the previous commit and return instantly — you'd proceed to merge on a stale review.

Use this **poll-until-re-armed, then watch** sequence:

```bash
# 1. Capture the HEAD SHA you just pushed.
HEAD_SHA=$(git rev-parse HEAD)

# 2. Poll until the CodeRabbit check is either PENDING (re-armed for HEAD) or
#    a terminal state whose startedAt is after your push (i.e. it already finished
#    reviewing the new commit). This guarantees we are not looking at a stale
#    SUCCESS from a prior commit.
PUSH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for i in $(seq 1 40); do  # up to ~10 min at 15s
  read -r STATE STARTED < <(gh api "repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>" \
    --jq '[.statusCheckRollup[]? | select(.context=="CodeRabbit")][-1] | "\(.state // "NONE") \(.startedAt // "")"')
  # Re-armed for new commit (PENDING) OR already finished past our push timestamp.
  if [ "$STATE" = "PENDING" ] || { [ -n "$STARTED" ] && [[ "$STARTED" > "$PUSH_TS" ]]; }; then
    break
  fi
  sleep 15
done

# 3. Now safe to block on --watch (it will wait for PENDING → terminal).
gh pr checks <PR_NUMBER> --watch
```

This blocks until CodeRabbit actually reviews the current HEAD. Once it returns, read reviews from ALL three comment locations:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

Filter reviews/comments by `submitted_at > PUSH_TS` (or `commit_id == HEAD_SHA` for inline comments) so you only act on findings for the newest commit.

## Step 10: Handle review results

Look across all three endpoints for review feedback from CodeRabbit. It may post findings as formal reviews or regular comments.

- **APPROVED** with no critical issues → proceed to Phase 3.
- **CHANGES_REQUESTED** or any comment flagging issues → fix them, push, **re-run the full Test Loop (Phase 1)**, then come back to Step 9.
- **REVIEW SKIPPED** (e.g., "Too many files!") → first try filtering, then escalate only if filtering doesn't fit. CodeRabbit Free caps reviews at 150 files. Add safe path filters to `.coderabbit.yaml`'s `reviews.path_filters` block, push, and let the next CodeRabbit run pick up the new filter. The list below is the canonical safe-filter set — these paths are already gated by /deploy's local checks, so excluding them from CodeRabbit doesn't lose coverage:
  ```yaml
  # Tests (gated by Step 5a / Step 6 / Step 6b locally)
  - "!**/tests/**"
  - "!**/*.blackbox.ts"
  - "!**/*.blackbox.tsx"
  - "!**/*.blackbox.py"
  - "!**/*.test.ts"
  - "!**/*.test.tsx"
  - "!**/*.test.py"
  - "!**/*.spec.ts"
  - "!**/test_*.py"
  - "!front-end/tests-e2e/**"
  # Benchmark harness (gated by Step 6 smoke run)
  - "!agents/benchmarks/**"
  # Prompt strings (no logic — text-only changes)
  - "!agents/tools/prompts/**"
  # Docs, markdown, harness config
  - "!docs/**"
  - "!**/*.md"
  - "!.claude/**"
  - "!.coderabbit.yaml"
  - "!.gitignore"
  - "!.editorconfig"
  - "!**/eslint.config.*"
  # Python scaffolding (re-exports + dataclass configs/types + thin HTTP repo wrappers)
  - "!**/__init__.py"
  - "!agents/**/config.py"
  - "!agents/**/types.py"
  - "!agents/**/repo.py"
  ```
  Verify the file count drops below 150 before pushing:
  ```bash
  python3 -c "
  import subprocess, re
  base = subprocess.check_output(['git','merge-base','origin/main','HEAD']).decode().strip()
  files = subprocess.check_output(['git','diff','--name-only', base + '...HEAD']).decode().splitlines()
  pats = [r'^.+/tests/', r'.+\.(blackbox|test|spec)\.(ts|tsx|py)$', r'^agents/benchmarks/', r'^agents/tools/prompts/', r'^docs/', r'.+\.md$', r'^\.claude/', r'^\.coderabbit\.yaml$', r'.+/__init__\.py$', r'^agents/.+/(config|types|repo)\.py$', r'.+/eslint\.config\.']
  remaining = [f for f in files if not any(re.search(p, f) for p in pats)]
  print(f'{len(files)} -> {len(remaining)}')
  "
  ```
  If the projected count is still ≥150 after applying the canonical set, escalate to the user — splitting the PR or upgrading CodeRabbit is the only remaining option.
- **No issues found** → proceed to Phase 3.

**Fix ALL valid issues**, regardless of whether the code was modified in this PR. "Pre-existing" or "not my code" is NOT a valid reason to skip a real bug, security issue, or correctness problem. If CodeRabbit found it, and it's a real issue, fix it. Only skip true style nits (formatting, naming preferences, etc.) that have zero correctness impact.

**Reply to every review comment** before proceeding. For each comment, reply with one of:

- `[FIXED] <short solution description>` — if you fixed the issue
- `[IGNORED] <reason>` — ONLY for pure style nits with zero correctness/security impact

Use `gh api` to post replies:

```bash
# Reply to a pull request review comment (inline code comment)
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies -f body="[IGNORED] style nit"

# Reply to an issue comment (regular PR comment)
gh api repos/{owner}/{repo}/issues/comments/<COMMENT_ID> -X PATCH -f body="<original body>\n\n[IGNORED] style nit"
```

---

# Phase 3: Finalize

Only enter this phase when the Test Loop is green AND the review is approved.

## Step 11: Archive plan (if applicable)

Check if there's an active plan related to this branch's work:

```bash
ls docs/plans/active/ 2>/dev/null
```

If a related plan exists in `docs/plans/active/`:

1. Move it to `docs/plans/completed/`:
   ```bash
   git mv docs/plans/active/<plan-file>.md docs/plans/completed/<plan-file>.md
   ```
2. Commit and push (no additional review needed for this change):
   ```bash
   git add docs/plans/completed/ && git commit -m "docs: archive plan to completed" && git push
   ```

## Step 11a: Cleanup stale workspaces

Terminate orphaned Temporal workflows and processes from archived Conductor workspaces. This only kills resources from **archived** workspaces — prod and all active workspaces are untouched.

```bash
cd "$(git rev-parse --show-toplevel)/back-end" && npx tsx scripts/cleanup-stale-workspaces.ts
```

This is best-effort — if it fails (e.g., no Temporal API key, no Docker), proceed to merge anyway.

## Step 12: Merge

**First, push any unpushed local commits so the PR head is current.** Because the PR was pushed early (Step 4d), any commit made afterward — recorded smoke durations (Step 6), the archived plan (Step 11), or test-loop fix commits — may be local-only. Merging would silently drop them. Push before merging:

```bash
# Land any commits made after the early Step 4d push onto the PR branch.
if [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ]; then
  git push
fi
```

Merge without deleting the branch. Do not delete the local branch or the remote branch unless the user explicitly asks for that.

```bash
gh pr merge <PR_NUMBER> --merge
```

If `main` can be checked out in this worktree, switch back to main and pull:

```bash
git checkout main && git pull origin main
```

If `main` is already checked out in another worktree, do not force a branch deletion or branch switch just to satisfy this step. Leave the current branch checked out and refresh refs instead:

```bash
git fetch origin main
```

## Step 13: Wait for deploys

Determine which deploy workflows are relevant based on what files changed in the PR. Check using `git diff main~1..main --name-only`:

- Changes in `agents/` → poll `deploy-agents.yml`
- Changes in `research/supabase/functions/` or `research/deploy.sh` → poll `deploy-research.yml`
- Changes in `back-end/` → Render auto-deploys (no workflow to poll, just wait ~60s)
- Changes in `front-end/` → Vercel auto-deploys (no workflow to poll, just wait ~60s)
- Changes in `mac-app/` → check if PR had `MAC-APP-RELEASE` label; if so, poll `release-mac-app.yml`

For GitHub Action workflows, wait for the new run to appear then watch it:

```bash
# Wait up to 60s for a workflow run that started after merge
MERGE_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for i in $(seq 1 12); do
  RUN_ID=$(gh run list --workflow <workflow-name>.yml --branch main --limit 1 --json databaseId,createdAt --jq ".[0] | select(.createdAt >= \"$MERGE_TIME\") | .databaseId")
  [ -n "$RUN_ID" ] && break
  sleep 5
done
gh run watch "$RUN_ID"
```

This avoids watching a stale run that started before the merge. Repeat for each relevant workflow.

If a deploy fails:

1. Show the failure to the user
2. If fixable, create a new fix branch/commit, push, create a new PR (Step 8), then continue from Step 9.

## Step 14: New branch

Run `/new_branch_with_context` to sync with main and create a new branch so we can keep working.

## Step 14a: Restore original workspace title

After `/new_branch_with_context` finishes, restore the workspace title captured in Step 0 so the Conductor workspace returns to the pre-deploy name (and not the PR title or the new branch's auto-synced name):

```bash
if [ -n "$ORIGINAL_WORKSPACE_TITLE" ]; then
  /rename $ORIGINAL_WORKSPACE_TITLE
fi
```

If `ORIGINAL_WORKSPACE_TITLE` was empty in Step 0, skip this step.

## Step 15: Done

After the new branch is created, report to the user:

- PR URL
- Which services were deployed
- Any review issues that were fixed along the way
- The new branch name
