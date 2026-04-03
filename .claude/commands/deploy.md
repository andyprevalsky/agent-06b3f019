---
description: "Push current branch, wait for PR review to pass, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, wait for CodeRabbit review, merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

---

# Phase 1: Test Loop

Run all checks locally. If any step fails, fix the issue and re-run that step. If fixing required code changes, re-run the entire Test Loop from the top.

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

If any files were modified by this step, stage and commit them (can combine with Step 1's commit if both ran together).

## Step 3: TypeScript type check

```bash
cd back-end && npx tsc --noEmit
```

Catches type errors that ESLint misses (wrong argument types, missing properties, bad generics). Fix any errors before proceeding.

## Step 4: Structural tests + fix

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

This enforces architectural invariants across all domains: import direction, cross-domain isolation, provider/util boundaries, domain completeness, Prisma/Express encapsulation, and circular import detection.

If any invariant fails, fix the violation. The test output includes remediation guidance (e.g., "Move the needed logic to service.ts or extract to a provider.").

## Step 5: Spin up local services

Spin up a port-isolated backend + research stack for testing. Use a high base port (4501) to avoid colliding with any running Conductor workspace. Set `TEMPORAL_TASK_QUEUE` to an isolated queue so workflows don't leak into other environments.

Only spin up what the tests need — **backend, research, and worker**. No frontend, mac-app.

```bash
# Port isolation (mirrors run.sh pattern: base, base+1, base+2, ...)
export SMOKE_PORT=4501          # backend
export SMOKE_HEALTH_PORT=4503   # worker health check
export SMOKE_RESEARCH_PORT=4504 # research (Supabase edge functions)
export SMOKE_QUEUE=navi-agent-tasks-deploy-smoke

# 1. Start research (Supabase edge functions — needs Docker)
cd "$(git rev-parse --show-toplevel)/research"
RESEARCH_PORT=$SMOKE_RESEARCH_PORT ./run-local.sh 2>&1 | tee research-logs.log &
RESEARCH_PID=$!

# Wait for research to be ready
for i in $(seq 1 60); do curl -s http://localhost:$SMOKE_RESEARCH_PORT/functions/v1/completions > /dev/null 2>&1 && break; sleep 2; done

# 2. Start backend
cd "$(git rev-parse --show-toplevel)/back-end"
DISABLE_GMAIL_SYNC=1 PORT=$SMOKE_PORT TEMPORAL_TASK_QUEUE=$SMOKE_QUEUE npx tsx watch src/server.ts 2>&1 | tee backend-logs.log &
BACKEND_PID=$!

# Wait for backend to be ready
for i in $(seq 1 30); do curl -s http://localhost:$SMOKE_PORT/health > /dev/null 2>&1 && break; sleep 1; done
```

**Teardown helper** (use after Step 5 failures or after Step 6 completes):
```bash
lsof -ti :$SMOKE_PORT | xargs kill -9 2>/dev/null || true  # backend
kill $WORKER_PID 2>/dev/null || true                        # worker (if started)
kill $RESEARCH_PID 2>/dev/null || true                      # research
(cd research/supabase && supabase stop 2>/dev/null) || true  # Supabase containers
```

## Step 5a: Blackbox API tests + fix

With the backend running from Step 5:

```bash
cd back-end
TEST_BASE_URL=http://localhost:$SMOKE_PORT npm run test:api
```

If tests fail, run the teardown helper, fix the issue, and re-run from the top of the Test Loop.

## Step 6: Smoke benchmarks + fix

With backend + research still running, start a local Temporal worker on the same isolated queue and run the smoke benchmark suite:

```bash
# Start local Temporal worker on the isolated queue, pointing at local backend + research
cd "$(git rev-parse --show-toplevel)/agents" && source venv/bin/activate
TEMPORAL_TASK_QUEUE=$SMOKE_QUEUE \
  BACKEND_API_URL=http://localhost:$SMOKE_PORT \
  HEALTH_CHECK_PORT=$SMOKE_HEALTH_PORT \
  ENVIRONMENT=development \
  RESEARCH_PORT=$SMOKE_RESEARCH_PORT \
  python worker.py 2>&1 | tee navi-worker-log.txt &
WORKER_PID=$!

# Wait for worker to be ready
for i in $(seq 1 30); do grep -q "started" navi-worker-log.txt 2>/dev/null && break; sleep 1; done

# Run smoke benchmarks against local backend
python benchmarks/run_benchmark.py --suite smoke --ci --parallel --url http://localhost:$SMOKE_PORT
```

This runs 3 e2e tests (chat-mode, spawn-sub-agents, parallel-tool-calls) against the local backend + worker + research. The `--ci` flag exits non-zero on failure. The `--parallel` flag runs all 3 tasks concurrently.

**After benchmarks complete (pass or fail), run the teardown helper from Step 5.**

If benchmarks fail, diagnose using local logs (see below), fix the issue, and re-run from the top of the Test Loop.

Results are saved to `agents/benchmarks/runs/`. Report the pass rate and total cost to the user.

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

# Phase 2: CI/CD Loop

## Step 7: Prepare the branch

1. Check `git status` for uncommitted changes. If there are any, stage and commit them with a descriptive message.
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

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If a PR already exists for this branch, skip creation and use the existing one.

## Step 9: Wait for code review

Poll `gh pr checks <PR_NUMBER> --json name,state` every 30 seconds until the "CodeRabbit" check reaches `SUCCESS` state. **No timeout — keep waiting.**

Once CodeRabbit completes, read reviews from ALL three comment locations:
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
gh pr merge <PR_NUMBER> --squash
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

For GitHub Action workflows, poll every 30 seconds:

```bash
gh run list --workflow <workflow-name>.yml --branch main --limit 1 --json status,conclusion,createdAt
```

Wait for all relevant deploys to show `completed` with `success` conclusion.

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
