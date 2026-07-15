---
description: "Push current branch, obtain a CodeRabbit or Claude fallback review, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, obtain a CodeRabbit review (or Claude Code fallback), merge, and wait for deploys to finish.

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
- A brief summary of the output (e.g., "0 errors", "3 files formatted", "7/7 benchmarks passed")

Build the report as a markdown table:

```
| Step | Status | Summary |
|------|--------|---------|
| Prettier | ✅ Pass | 3 files formatted |
| ESLint | ✅ Pass | 0 errors |
| TypeScript | ✅ Pass | 0 errors |
| Structural Tests | ✅ Pass | All invariants hold |
| Blackbox API Tests | ✅ Pass | 12/12 tests passed |
| Smoke Benchmarks | ✅ Pass | 7/7 passed locally, `RESULTS: 7/7 passed`, run `runs/<...>.json` |
```

Carry this report forward into Phase 2 for use in the commit message and PR body.

## Step 0: Change detection + execution plan

All Phase 1 commands run from the repo root. Compute changed paths from the complete active worktree: committed branch changes, staged/unstaged tracked changes, and untracked non-ignored files. This prevents pre-commit deploy checks from incorrectly treating a dirty branch as unchanged.

```bash
BASE_REF="${DEPLOY_BASE_REF:-origin/main}"
CHANGED=$({
  git diff --name-only "$BASE_REF"...HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u)
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

**What "prompt modification" means — LLM-visible text, not file membership.** The rule reviews changes to what an LLM actually reads: prompt/instruction text baked in at compile time (system prompts, tool descriptions, skill/command instructions, tasks.json `prompt`/`description` fields, template files) AND text assembled at runtime (string-building logic, template interpolation, context-chunk selection, truncation — anything that changes the bytes an LLM ultimately sees). The guard script flags candidate FILES, which over-approximates: a validation helper, UI accessibility tweak, or state-handling fix inside a flagged file is NOT a prompt modification. When the guard fires:

1. Examine every flagged hunk and classify it: does it change (or change the construction of) text an LLM ever sees — at compile time or runtime?
2. If NO hunk changes LLM-visible text: state that determination in the deploy log (per file, one line on why it is code-behavior only), then pass the guard with the mandatory flag WITHOUT waiting for human approval. Record `Prompt Human Approval Guard | Pass | flagged files are code-behavior only (no LLM-visible text changed): <files>` in `TEST_REPORT`.
3. If ANY hunk changes LLM-visible text — or you are unsure (runtime string construction counts) — stop and request human approval for those hunks. When mixed, list which hunks need review and which are code-behavior-only so the human reviews only what matters.

Run the guard without the approval flag first:

```bash
bash scripts/check-prompt-human-approval.sh
```

If it passes, record `Prompt Human Approval Guard | Pass | no prompt edits detected` in `TEST_REPORT`.

If it fails, apply the classification above. For hunks that change LLM-visible text, stop and ask the human to review them. Do not infer approval from silence, prior discussion, or the fact that the branch exists.

Human approval is scoped only to the prompt diff that exists when approval is requested. If LLM-visible text in any prompt, instruction, command, skill, or prompt-related file changes later — including changes made to fix tests or smoke benchmarks — re-run the guard without the approval flag, show the new prompt diff, and wait for fresh explicit approval before continuing. Later code-behavior-only changes to flagged files follow rule 2 above (classify, log, proceed).

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

**Step 5.0 (MANDATORY pre-flight garbage collection):** before spinning up anything, kill any stale run.sh trees + orphaned backend/worker/supabase processes from prior aborted runs in this worktree. This guarantees a clean local blackbox/semantic stack; cloud smoke uses separate task-scoped queues.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/list-services.sh           # inspect what's running (optional, informational)
bash scripts/kill-services.sh           # kill the whole tree; preserves DB container + volume
```

`scripts/kill-services.sh` is worktree-scoped (uses `$PWD` as the filter), walks descendants via `pgrep -P`, SIGTERMs then SIGKILLs survivors, and deliberately leaves the Postgres container intact. Re-run it any time you need a clean slate — it is idempotent.

Spin up the local stack through `scripts/run.sh --benchmark`. This stack serves blackbox, semantic, AND Pre-Deploy smoke gates — smoke runs locally against this same stack (Step 6), not in cloud-bench. In benchmark mode, `run.sh` starts `back-end`, `front-end`, and `agents`, and skips `mac-app`. When this command is used inside Conductor, `run.sh` derives the backend, frontend, and worker-health ports from `CONDUCTOR_PORT`.

```bash
# Conductor provides the base port; run.sh fans out backend/frontend/health/research from it.
if [ -z "$CONDUCTOR_PORT" ]; then
  echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
  exit 1
fi

export SMOKE_BASE_URL="http://localhost:$CONDUCTOR_PORT"
export SMOKE_HEALTH_URL="http://localhost:$((CONDUCTOR_PORT + 2))"
SEMANTIC_QUEUE_WORKSPACE="${CONDUCTOR_WORKSPACE_NAME:-local}"
export TEMPORAL_TASK_QUEUE="navi-agent-tasks-${SEMANTIC_QUEUE_WORKSPACE}-deploy-$(date -u +%Y%m%d%H%M%S)-$$"

cd "$(git rev-parse --show-toplevel)"
```

**CRITICAL: Start the DB container BEFORE `run.sh` so that `run.sh` treats it as pre-existing and won't stop it on cleanup.** `run.sh` has an EXIT trap that stops all services it started — including the DB container. By pre-starting the DB, `run.sh` sees it as already running and skips DB cleanup, which prevents the DB from dying if `run.sh` exits for any reason (signal, child process exit, timeout, etc.).

```bash
# Step 1: Ensure DB is running BEFORE run.sh starts (so run.sh won't own/stop it)
DB_CONTAINER="victoria-db-${CONDUCTOR_WORKSPACE_NAME:-local}"
LOCAL_DB_PORT=$((CONDUCTOR_PORT + 5))

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
DISABLE_GMAIL_SYNC=1 BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=1 TRACE_ARCHIVE_ENABLED=0 \
  bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
```

The local latency gate disables trace-archive fixture recording because that
out-of-band benchmark recorder copies the user's full browser environment and
is not part of the visible chat lifecycle. The post-deploy production semantic
gate below runs against the normally configured deployed services, so production
instrumentation remains covered before `/deploy` can report success.

Then, in separate (foreground) Bash calls, wait for each service:

```bash
# Wait for backend, frontend, and worker health to be ready
for i in $(seq 1 60); do curl -s "$SMOKE_BASE_URL/health" > /dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 60); do curl -s "$SMOKE_HEALTH_URL/health" > /dev/null 2>&1 && break; sleep 2; done
export SMOKE_FRONTEND_URL="http://localhost:$((CONDUCTOR_PORT + 1))"
for i in $(seq 1 60); do curl -sf "$SMOKE_FRONTEND_URL" > /dev/null 2>&1 && break; sleep 2; done
```

**Teardown (MANDATORY):** after Step 6b finishes (pass OR fail), and any time you abort the local gates mid-way, you MUST tear the stack down before moving on. Skipping this leaves zombie run.sh + grandchildren that leak ports, RAM, and worker slots across `/deploy` invocations.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/kill-services.sh                    # kills run.sh tree, preserves DB
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

**Pre-Deploy smoke runs LOCALLY, not in cloud-bench.** Run the complete Pre-Deploy group through the local isolated benchmark stack (`scripts/run-bench --local`) — the same `run.sh --benchmark` backend + worker + research + Postgres that Step 5 already brought up on this machine. Do NOT use `scripts/run-predeploy-cloud` / the Fly fleet / the Benchmark Hub for the deploy gate; those remain available for scale experiments but are not the pre-deploy path.

```bash
cd "$(git rev-parse --show-toplevel)"
# Derive the smoke task set from every catalog entry tagged `smoke`, then run
# them all on the LOCAL isolated stack (max_concurrency handled by the runner).
SMOKE_TASKS=$(cd agents && venv/bin/python -c "import json;d=json.load(open('benchmarks/tasks.json'));t=d if isinstance(d,list) else d.get('tasks',d);t=list(t.values()) if isinstance(t,dict) else t;print(' '.join(x['name'] for x in t if 'smoke' in (x.get('tags') or [])))")
echo "smoke tasks: $SMOKE_TASKS"
CONDUCTOR_PORT="$CONDUCTOR_PORT" CONDUCTOR_WORKSPACE_NAME="$CONDUCTOR_WORKSPACE_NAME" \
  bash scripts/run-bench --local $SMOKE_TASKS
```

`scripts/run-bench --local` opts into `benchmarks/local.py`, which runs each task against the local backend/worker/research/Postgres on THIS machine (per-run ports derived from `CONDUCTOR_PORT`). It refreshes compute tokens + browser cookies/passwords from prod at runtime, then runs the tagged smoke tasks in parallel and prints a `RESULTS: N/N passed` line.

The command is the gate: it exits non-zero unless every smoke task is `passed`. The task set must exactly match the catalog's `smoke` group. Record the `RESULTS:` line and the saved `runs/*.json` path in `TEST_REPORT`. (A long-running local run can exceed the ~10-min background-task cap — launch it detached, e.g. `nohup … & disown`, and poll its log.)

### Active-worktree contract

The local run tests exactly the working tree on this machine — the checked-out `HEAD` plus any staged/unstaged edits — so there is no fleet checkout or binary-patch step to worry about. Still:

- Step 4d commits all intended new/untracked files before runtime tests.
- Before starting smoke, fail if an intended untracked file remains; commit it and restart the Test Loop. Gitignored `.context/` artifacts do not count.

Timeout history remains catalog-driven on the checked-out ref. Do not fabricate or manually copy duration rows as part of deploy.

### Monitoring agent progress during smoke tests

**Do NOT fire-and-forget.** Monitor the local run's log (the report card printed by `local.py`, `agents/navi-worker-log.txt`, and `back-end/backend-logs.log`).

**Universal background-task cadence (applies here AND to every background task in this repo):**

- **First 60 seconds:** poll every **10 seconds** (catches silent early deaths — 0-byte logs, missing-env crashes, queue-routing bugs)
- **After 60 seconds:** poll every **60 seconds**
- **Exit the monitor the instant the last task finishes** — do NOT keep sleeping out the interval. As soon as the completion signal is seen (`LOCAL_SMOKE_EXIT=`, the "RESULTS:" line, PID no longer running), stop polling and move on.

At each poll, check:

- All smoke tasks remain present in the run's report card
- Task status (`queued`, `running`, `passed`, `failed`, `error`)
- Any error/traceback lines in `agents/navi-worker-log.txt` / `back-end/backend-logs.log`
- The `local.py` / `run_benchmark.py` PID remains alive until `RESULTS:` prints

**If any task shows signs of trouble** (runner exit, task `failed`/`error`, or no progress beyond its derived timeout), immediately:

1. Preserve the run's `runs/*.json` + `runs/*_diagnostics/` and the failed `agent_id`
2. Read `agents/navi-worker-log.txt` and `back-end/backend-logs.log` for the failed agent BEFORE the stack tears down (local logs are wiped on teardown)
3. Fix the root cause
4. Restart the Test Loop and re-run the full Pre-Deploy smoke group locally

### Pass criteria

**ALL Pre-Deploy smoke benchmarks must pass locally — currently 7/7, with 0 failures.** The local run must print `RESULTS: 7/7 passed` and exit 0. Timeouts, stalls, wrong tool usage, backend crashes, or any other failure mode must be diagnosed and fixed. You are expected to root-cause every failure and fix it in code. This is not optional — smoke failures are real bugs.

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
Smoke task <task-name> just failed in /deploy (LOCAL run). Agent ID: <agent_id>.
Failure reason from benchmark runner: <reason string from results JSON>.

Repo root: <abs path>. Run record: <abs path to agents/benchmarks/runs/<run>.json> + its `_diagnostics/` dir.

Steps 1–5 — do them all, do not stop early:

1. Read the run's `runs/<run>.json`, its `runs/<run>_diagnostics/` dir, and
   the local `agents/navi-worker-log.txt` + `back-end/backend-logs.log` for the
   failed agent_id (truncate aggressively as you go, keeping only relevant
   windows). NOTE: local logs are wiped on stack teardown — capture them fast.

2. Run BOTH diagnostic summaries IN PARALLEL on the failed agent_id, then
   fully expand whichever one points at the smoking gun (LOCAL, so no
   `--prod` / `--url`):
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

When all spawned agents return, **the main loop** re-runs static checks for
the fix, and re-runs the full local smoke group from the top. If the same task fails again with
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

If a benchmark fails due to local infrastructure (stale DB, dead worker, port drift), fix the local stack (re-run `scripts/setup-db.sh`, restart `run.sh --benchmark`) and re-run the smoke group. A partial pass does not satisfy the 7/7 gate.

### Local cleanup

The local smoke stack is the Step 5 `run.sh --benchmark` stack. Tear it down with `scripts/kill-services.sh` (preserves the DB container) after semantic tests finish. Capture any failed agent's logs BEFORE teardown — local `navi-worker-log.txt` / `backend-logs.log` are overwritten on the next run.

### Diagnosing failures

When any local smoke benchmark fails, start with the run artifacts before making code changes:

| Surface | Artifact | What to look for |
| ------- | -------- | ---------------- |
| Runner | `local.py` report card / `RESULTS:` line | which task failed + evaluator reason |
| Result | `agents/benchmarks/runs/<run>.json` + `runs/<run>_diagnostics/` | failed agent ID and failure_reason |
| Worker | `agents/navi-worker-log.txt` | tracebacks, tool errors, LLM-call failures |
| Backend | `back-end/backend-logs.log` | 500s, Prisma errors, route failures |

For benchmark-specific diagnostics, run ALL three summaries in parallel — they answer different questions (LOCAL, so no `--prod` / `--url`):

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

**Semantic tests run on every /deploy and may never be skipped.** This is independent of the smoke-benchmark change classifier: documentation-only, test-only, frontend-only, and backend-only deploys all run the complete semantic suite. A deploy changes production state even when the app diff is small, so the user-visible frontend contract is always re-proven.

### Running semantic tests

With the full stack from Step 5 still running (backend, worker, research, **and frontend on `$SMOKE_FRONTEND_URL`**):

```bash
cd "$(git rev-parse --show-toplevel)"
SEMANTIC_WORKERS=4 BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash front-end/scripts/run-semantic-tests.sh
```

The runner generates one authenticated session and shares it across all four Playwright workers. Every semantic spec runs. Inside the lifecycle spec, the `direct_answer`, `web_search`, `agent_plan`, and `agent_execute` paths run concurrently; each path takes five independent samples and every sample must complete the full browser lifecycle in under five seconds.

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

# ║ 6. Smoke benchmarks: complete Pre-Deploy group passes ║

# ║ LOCALLY (currently 7/7), `RESULTS: 7/7 passed` — OR ║

# ║ explicitly skipped per the ║

# ║ "When smoke can be skipped" table in Step 6 (diff must be ║

# ║ limited to safe paths; if ANY must-run path is touched, smoke ║

# ║ is required) ║

# ║ 6b. Semantic tests: 100% pass on every /deploy; never skipped. ║

# ║ Includes four concurrent chat paths × five full-lifecycle samples, ║

# ║ with every sample below the five-second ratchet. ║

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

This blocks until the CodeRabbit check completes for the current HEAD. **A green check alone does not prove a review happened.** Once it returns, read reviews from ALL three comment locations:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

Filter reviews/comments by `submitted_at > PUSH_TS` (or `commit_id == HEAD_SHA` for inline comments) so you only act on findings for the newest commit.

### Step 9a: Verify CodeRabbit delivered a substantive review

Inspect the newest CodeRabbit-authored content from all three endpoints. Treat CodeRabbit as unavailable and run the Claude fallback when any of these is true:

- The check is missing, failed, or timed out.
- The newest bot output contains `Review limit reached`, `rate limited`, `usage spending cap`, `review skipped`, or a service/internal error.
- The check is green but there is no substantive review result for `HEAD_SHA`. A quota/error comment is not a review.

Do not repeatedly request more CodeRabbit reviews during a quota window. Trigger exactly one Claude review for the current HEAD by toggling the opt-in label:

```bash
FALLBACK_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh label create claude-review-fallback \
  --description "Run Claude Code review when the primary reviewer is unavailable" \
  --color 7B61FF --force
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/labels/claude-review-fallback \
  -X DELETE >/dev/null 2>&1 || true
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/labels \
  -X POST -f 'labels[]=claude-review-fallback' >/dev/null
```

Wait for the workflow run created after `FALLBACK_TS` and require it to succeed:

```bash
FALLBACK_RUN_ID=""
for i in $(seq 1 40); do
  FALLBACK_RUN_ID=$(gh run list \
    --workflow claude-code-review-fallback.yml \
    --event pull_request \
    --limit 20 \
    --json databaseId,createdAt,headSha \
    --jq ".[] | select(.headSha == \"$HEAD_SHA\" and .createdAt > \"$FALLBACK_TS\") | .databaseId" \
    | head -1)
  [ -n "$FALLBACK_RUN_ID" ] && break
  sleep 15
done
[ -n "$FALLBACK_RUN_ID" ] || { echo "Claude fallback did not start" >&2; exit 1; }
gh run watch "$FALLBACK_RUN_ID" --exit-status
```

After success, read the three comment endpoints again and filter at `FALLBACK_TS`. The official code-review plugin posts only findings scoring at least 80; a successful workflow with no findings comment means no high-confidence issues were found. If the workflow fails, do not merge—inspect `gh run view "$FALLBACK_RUN_ID" --log-failed`, repair the fallback, and rerun it for the same HEAD.

Remove the fallback label after a successful review so later pushes do not spend Claude quota unless the fallback is explicitly requested again:

```bash
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/labels/claude-review-fallback \
  -X DELETE >/dev/null 2>&1 || true
```

## Step 10: Handle review results

Look across all three endpoints for review feedback from CodeRabbit or the Claude fallback. Either reviewer may post findings as formal reviews or regular comments.

- **APPROVED** with no critical issues → proceed to Phase 3.
- **CHANGES_REQUESTED** or any comment flagging issues → fix them, push, **re-run the full Test Loop (Phase 1)**, then come back to Step 9.
- **CODE RABBIT UNAVAILABLE** (quota, spending cap, rate limit, service failure, or false-green check) → use the Claude fallback from Step 9a.
- **REVIEW SKIPPED** (e.g., "Too many files!") → first try filtering, then use the Claude fallback if filtering doesn't fit. CodeRabbit Free caps reviews at 150 files. Add safe path filters to `.coderabbit.yaml`'s `reviews.path_filters` block, push, and let the next CodeRabbit run pick up the new filter. The list below is the canonical safe-filter set — these paths are already gated by /deploy's local checks, so excluding them from CodeRabbit doesn't lose coverage:
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

**Fix ALL valid issues**, regardless of whether the code was modified in this PR. "Pre-existing" or "not my code" is NOT a valid reason to skip a real bug, security issue, or correctness problem. If CodeRabbit or Claude found it, and it's a real issue, fix it. Only skip true style nits (formatting, naming preferences, etc.) that have zero correctness impact.

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
- Changes in `back-end/` → Render auto-deploys (no workflow to poll). **Do NOT just "wait ~60s" — run Step 13a to confirm the merged commit went live AND the app is functionally healthy.**
- Changes in `front-end/` → Vercel auto-deploys. Wait for a successful GitHub deployment status tied to the merged SHA; a fixed sleep is not proof that the new frontend is live.
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

For a frontend change, wait for Vercel to report the merged commit as live:

```bash
if [ -n "$CHANGED_FRONTEND" ]; then
  MERGED_SHA=$(git rev-parse main)
  VERCEL_OK=""
  for i in $(seq 1 90); do
    DEPLOYMENT_ID=$(gh api "repos/{owner}/{repo}/deployments?sha=$MERGED_SHA" \
      --jq '[.[] | select(.creator.login == "vercel[bot]")][0].id // empty')
    if [ -n "$DEPLOYMENT_ID" ]; then
      VERCEL_STATE=$(gh api "repos/{owner}/{repo}/deployments/$DEPLOYMENT_ID/statuses" \
        --jq '.[0].state // "pending"')
      echo "  Vercel: state=$VERCEL_STATE deployment=$DEPLOYMENT_ID"
      case "$VERCEL_STATE" in
        success) VERCEL_OK=1; break ;;
        failure|error|inactive) VERCEL_OK=failed; break ;;
      esac
    fi
    sleep 10
  done
  [ "$VERCEL_OK" = "1" ] || { echo "❌ Vercel did not bring $MERGED_SHA live"; exit 1; }
fi
```

If a deploy fails:

1. Show the failure to the user
2. If fixable, create a new fix branch/commit, push, create a new PR (Step 8), then continue from Step 9.

## Step 13a: Verify prod backend health (functional, not just liveness)

**Skip if `$CHANGED_BACKEND` is empty.** Run this whenever the PR touched `back-end/` (code, `schema.prisma`, or `migrations/`).

Render has no GitHub Actions run to watch, so the only proof a backend deploy is good is to (1) confirm Render brought the **merged commit** live and (2) hit a **real DB-backed endpoint** in prod. A `200` on `/health` is NOT sufficient — `/health` does no DB work, so a missing migration column, a broken Prisma client, or a bad env var returns `200` on `/health` while every real endpoint `500`s. (This exact failure took prod down on 2026-06-27: `Agent.fastModeCacheEnabled` was absent from the prod DB, so `/health`=200 but `GET /api/agents`=500 for everyone.)

### Step 1 — Wait for Render to bring the merged commit live

```bash
cd "$(git rev-parse --show-toplevel)/back-end" && source .env
MERGED_SHA=$(git rev-parse main)   # the commit that just merged
echo "Waiting for Render to deploy ${MERGED_SHA:0:7}..."
DEPLOY_OK=""
for i in $(seq 1 90); do  # up to ~15 min at 10s (Render builds can be slow)
  read -r STATUS COMMIT < <(curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
    "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=1" \
    | python3 -c "import sys,json; d=json.load(sys.stdin)[0]['deploy']; print(d.get('status',''), (d.get('commit') or {}).get('id','')[:7])")
  echo "  Render: status=$STATUS commit=$COMMIT (want ${MERGED_SHA:0:7})"
  case "$STATUS" in
    live)
      if [ "$COMMIT" = "${MERGED_SHA:0:7}" ]; then DEPLOY_OK=1; break; fi ;;
    build_failed|update_failed|canceled|pre_deploy_failed)
      echo "❌ Render deploy $STATUS for $COMMIT"; DEPLOY_OK="failed"; break ;;
  esac
  sleep 10
done
[ "$DEPLOY_OK" = "1" ] || { echo "❌ Render did not bring ${MERGED_SHA:0:7} live (last status: $STATUS)"; exit 1; }
echo "✅ Render live on ${MERGED_SHA:0:7}"
```

If Render reports `build_failed`/`update_failed`, fetch the deploy logs (`GET /v1/services/$RENDER_SERVICE_ID/deploys/<id>` + the events/log API, or the Render dashboard) and treat it like any deploy failure above — fix, new PR, continue from Step 9.

### Step 2 — Functional health probe (liveness + DB/Prisma path)

```bash
PROD_URL="https://navi-j9a9.onrender.com"
API_KEY="AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag="
USER_ID="1f85ff25-6e29-4c1b-8739-f917bd101a30"

# (a) Liveness — process is up.
curl -sf "$PROD_URL/health" >/dev/null || { echo "❌ /health failed"; exit 1; }

# (b) Functional — exercises the DB/Prisma layer. Catches schema/migration
#     mismatches, broken Prisma client, and missing env that /health hides.
#     Poll briefly: Render flips to "live" a beat before the new process serves traffic.
HEALTHY=""
for i in $(seq 1 12); do  # ~1 min
  CODE=$(curl -s -o /tmp/prod-agents.json -w "%{http_code}" "$PROD_URL/api/agents" \
    -H "X-API-Key: $API_KEY" -H "X-User-Id: $USER_ID")
  [ "$CODE" = "200" ] && { HEALTHY=1; break; }
  echo "  /api/agents -> $CODE (retry $i)"; sleep 5
done
[ "$HEALTHY" = "1" ] || { echo "❌ FUNCTIONAL CHECK FAILED: /api/agents -> $CODE"; head -c 500 /tmp/prod-agents.json; exit 1; }
echo "✅ /api/agents -> 200 (DB/Prisma path healthy)"

# (c) Multi-domain endpoint smoke — one representative DB-backed GET per domain,
#     fails on any 5xx. /api/agents proves ONLY the Agent domain; a single probe
#     missed the 2026-07-06 compute-token outage (ComputeTokenLineageLease /
#     ComputeTokenFastCacheAffinity tables never migrated -> every compute-token
#     fetch 500'd -> every agent fell to the paid waterfall, while /api/agents
#     stayed 200). This probe hits the compute-token route plus other domains.
cd "$(git rev-parse --show-toplevel)/back-end" && npx tsx scripts/prod-endpoint-smoke.ts
```

`GET /api/agents` is the canonical warmup probe because it runs an authenticated `prisma.agent.findMany()` — the same query class that broke on 2026-06-27. Step (c) then runs `back-end/scripts/prod-endpoint-smoke.ts`, which probes one DB-backed endpoint per domain (agents, models, benchmarks, user-settings, people, tool-usage, **integrations/compute-code token**, …) and fails on any 5xx. **When you add a new domain whose runtime path is independent of the ones already probed, add a line to the `PROBES` array in that script** — that is how we keep the post-deploy check from going stale.

### Step 3 — Scan post-deploy prod logs for runtime errors

A `200` from one probe doesn't prove the whole surface is clean. Pull recent prod logs and fail on any `prisma:error`, `does not exist`, or `-> 500` that appears after the deploy:

```bash
cd "$(git rev-parse --show-toplevel)/back-end" && source .env
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/logs?ownerId=$RENDER_OWNER_ID&resource=$RENDER_SERVICE_ID&limit=100&direction=backward" \
  | python3 -c "
import sys, json
logs = json.load(sys.stdin)['logs']
bad = [l for l in logs if any(s in l['message'] for s in ('prisma:error', 'does not exist', '-> 500', '\"status\":500'))]
print(f'post-deploy error lines: {len(bad)}')
for l in bad[:10]: print(l['timestamp'][11:19], l['message'][:160])
sys.exit(1 if bad else 0)
"
```

If this exits non-zero, the deploy is **unhealthy even though it's live** — treat as a deploy failure: diagnose the error (most likely a schema/migration mismatch or missing env var — see the 2026-06-27 incident for the migration-vs-DB drift pattern), fix it, new PR, continue from Step 9. Do NOT proceed to Step 14 with errors in the prod log.

**Migration-specific note:** if the error is a Prisma "column/table does not exist", the deployed code expects a schema the prod DB doesn't have. Verify the migration is both present in `back-end/prisma/migrations/` AND actually applied to prod (the migration row in `_prisma_migrations` can be marked applied while the column is absent if a stray `prisma db push` from another workspace dropped it — `back-end/.env` `DATABASE_URL` points at prod). Re-apply the missing DDL idempotently (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`) and re-run Step 2.

## Step 13b: Production semantic frontend gate (no skip — always runs)

After all changed services are live and Step 13a is green when applicable, dispatch the trusted production semantic workflow. This runs every frontend semantic spec in one job with four Playwright workers and one shared authenticated session. It includes the four-path, five-sample, full-lifecycle chat ratchet.

```bash
SEMANTIC_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run chat-lifecycle-ratchet.yml --ref main \
  -f frontend_url=https://roselabs.ai \
  -f backend_url=https://navi-j9a9.onrender.com

SEMANTIC_RUN_ID=""
for i in $(seq 1 40); do
  SEMANTIC_RUN_ID=$(gh run list \
    --workflow chat-lifecycle-ratchet.yml \
    --event workflow_dispatch \
    --branch main \
    --limit 20 \
    --json databaseId,createdAt \
    --jq ".[] | select(.createdAt >= \"$SEMANTIC_DISPATCH_TS\") | .databaseId" \
    | head -1)
  [ -n "$SEMANTIC_RUN_ID" ] && break
  sleep 5
done
[ -n "$SEMANTIC_RUN_ID" ] || { echo "❌ Production semantic workflow did not start"; exit 1; }
gh run watch "$SEMANTIC_RUN_ID" --exit-status
```

This is a hard deployment gate. If the workflow fails, the deployment is not complete: inspect its Playwright artifacts and service logs, fix the root cause in a new PR, and repeat the deploy loop. Do not report success or proceed to Step 14 while this check is red.

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
