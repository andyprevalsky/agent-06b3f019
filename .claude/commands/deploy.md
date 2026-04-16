---
description: "Push current branch, wait for PR review to pass, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, wait for CodeRabbit review, merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

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

## Step 1: Prettier format

All Phase 1 commands run from the repo root. Compute changed files once:

```bash
CHANGED_TS=$(git diff --name-only main...HEAD -- 'back-end/src/**/*.ts' | sed 's|^back-end/||')
```

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

1. Auto-fix:
   ```bash
   cd back-end && npx eslint --fix $CHANGED_TS
   ```
2. Verify zero errors remain:
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

## Step 5: Spin up local services

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

**Teardown helper** (use after Step 5 failures or after Step 6 completes). Note: this does NOT stop the DB — it stays alive for subsequent test runs. Use `scripts/teardown.sh` for full workspace cleanup.
```bash
pkill -f "scripts/run.sh --benchmark" 2>/dev/null || true
sleep 2
(cd research/supabase && supabase stop 2>/dev/null) || true
```

## Step 5a: Blackbox API tests + fix

With the backend running from Step 5:

```bash
cd back-end
BLACKBOX_TEST_USE_EXISTING_BACKEND=1 TEST_BASE_URL=$SMOKE_BASE_URL bash scripts/run-blackbox-tests.sh
```

**ALL domains must pass — 0 failures.** If ANY domain fails, you must fix it before proceeding, even if the failing domain was not modified in this PR. "Pre-existing" is not an excuse. Fix it, re-run, get 100%. If you cannot fix a failure, STOP and escalate to the user — do NOT proceed to Phase 2.

**ESCALATE IMMEDIATELY on third-party credit/billing errors.** If any test fails with "insufficient credits", "402", "quota exceeded", or similar billing errors from external providers (OpenRouter, OpenAI, E2B, Twilio, etc.), STOP and tell the user immediately. Do NOT try to fix this in code (e.g., accepting 500s). The user needs to add credits to the provider account.

## Step 6: Smoke benchmarks + fix

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

### Monitoring agent progress during smoke tests

**Do NOT fire-and-forget.** While benchmarks run, actively monitor agent progress by polling each agent's detail endpoint (`GET /api/agents/{id}`). Use this schedule:

```
5s, 5s, 5s, 15s, 30s, 60s, 60s, 60s, ... (repeat 60s until all agents finish)
```

At each poll, check:
- Agent status (ACTIVE, COMPLETED, FAILED, ERROR)
- Message count and latest messages
- Progress score
- Any error messages

**If any agent shows signs of trouble** (stuck at 0 messages for 30s+, ERROR status, backend 500s in logs), immediately:
1. Kill ALL running benchmark agents (DELETE each agent)
2. Read logs (backend, worker, research) to diagnose
3. Fix the root cause
4. Re-run sequentially (without `--parallel`) to isolate failures

### Pass criteria

**ALL 5 smoke benchmarks must pass — 0 failures.** Timeouts, stalls, wrong tool usage, backend crashes, or any other failure mode must be diagnosed and fixed. You are expected to root-cause every failure and fix it in code. This is not optional — smoke failures are real bugs.

**Diagnosis process:**
1. Read the log files (backend, worker, research — see table below)
2. Use `agent_logs.py` on failed agents to get the full event timeline
3. Identify which part of the agent lifecycle or LLM request is causing the failure (e.g., slow activity, backend crash under load, edge function error)
4. Fix the root cause in code, restart services, and re-run

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

| Service | Log file | What to look for |
|---------|----------|-----------------|
| Backend | `back-end/backend-logs.log` | HTTP errors, Temporal client failures, DB errors |
| Worker | `agents/navi-worker-log.txt` | Workflow tracebacks, activity failures, LLM call errors |
| Research | `research/research-logs.log` | Edge function errors, rate limits, auth failures |

For benchmark-specific diagnostics, also use:
```bash
cd agents && python benchmarks/agent_logs.py <agent_id> --tree --diagnostics
```

---

# ╔══════════════════════════════════════════════════════════════════════╗
# ║                    HARD GATE — PHASE 2 BLOCKED                     ║
# ║                                                                    ║
# ║  Do NOT enter Phase 2 unless ALL of the following are true:        ║
# ║                                                                    ║
# ║  1. Prettier: 0 formatting changes remaining                      ║
# ║  2. ESLint: 0 errors                                              ║
# ║  3. TypeScript: 0 errors                                          ║
# ║  4. Structural tests: 100% pass                                   ║
# ║  4a. Code coverage: meets thresholds in .c8rc.json                ║
# ║  5. Blackbox API tests: 100% pass (ALL domains)                   ║
# ║  6. Smoke benchmarks: 5/5 pass — ALL FIVE, NO EXCEPTIONS          ║
# ║                                                                    ║
# ║  If ANY test has ANY failure, you are BLOCKED.                     ║
# ║  Fix it or escalate to the user. Do NOT proceed.                   ║
# ║                                                                    ║
# ║  INVALID EXCUSES (do NOT use these to justify proceeding):         ║
# ║  - "Pre-existing" / "not related to my changes"                   ║
# ║  - "Infrastructure issue" / "flaky" / "resource contention"       ║
# ║  - "The code changes don't touch agent/Temporal code"             ║
# ║  - "Expired tokens" (re-run seed script or escalate to user)      ║
# ║  - "Temporal connectivity" (restart workers, fix it)              ║
# ║  - "Agents timing out" (investigate and fix)                      ║
# ║                                                                    ║
# ║  Merging or creating a PR with known failures is a CRITICAL       ║
# ║  ERROR. The user has explicitly and repeatedly stated this.        ║
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
gh pr create --title "<concise title>" --body "$(cat <<'EOF'
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

If a PR already exists for this branch, skip creation and use the existing one.

## Step 9: Wait for code review

Wait for all PR checks to complete:

```bash
gh pr checks <PR_NUMBER> --watch
```

This blocks until all checks finish (including CodeRabbit). Once it returns, read reviews from ALL three comment locations:
```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

## Step 10: Handle review results

Look across all three endpoints for review feedback from CodeRabbit. It may post findings as formal reviews or regular comments.

- **APPROVED** with no critical issues → proceed to Phase 3.
- **CHANGES_REQUESTED** or any comment flagging issues → fix them, push, **re-run the full Test Loop (Phase 1)**, then come back to Step 9.
- **REVIEW SKIPPED** (e.g., "Too many files!") → **STOP and escalate to the user.** Do NOT proceed to merge. Tell the user CodeRabbit skipped the review, explain why (file count, etc.), and ask how they want to proceed (e.g., filter paths, split PR, or merge without review).
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

## Step 12: Merge

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

## Step 15: Done

After the new branch is created, report to the user:
- PR URL
- Which services were deployed
- Any review issues that were fixed along the way
- The new branch name
