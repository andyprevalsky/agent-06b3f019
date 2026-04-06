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
DISABLE_GMAIL_SYNC=1 bash scripts/run.sh --benchmark 2>&1 | tee .context/deploy-smoke.log &
RUN_SH_PID=$!

# Wait for backend, worker health, and research to be ready
for i in $(seq 1 60); do curl -s "$SMOKE_BASE_URL/health" > /dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 60); do curl -s "$SMOKE_HEALTH_URL/health" > /dev/null 2>&1 && break; sleep 2; done
for i in $(seq 1 60); do curl -s "$SMOKE_RESEARCH_URL/functions/v1/completions" > /dev/null 2>&1 && break; sleep 2; done
```

**Teardown helper** (use after Step 5 failures or after Step 6 completes):
```bash
kill $RUN_SH_PID 2>/dev/null || true
wait $RUN_SH_PID 2>/dev/null || true
(cd research/supabase && supabase stop 2>/dev/null) || true
```

## Step 5a: Blackbox API tests + fix

With the backend running from Step 5:

```bash
cd back-end
TEST_BASE_URL=$SMOKE_BASE_URL npm run test:api
```

If tests fail, run the teardown helper, fix the issue, and re-run from the top of the Test Loop.

## Step 6: Smoke benchmarks + fix

With the local stack from Step 5 still running, run the smoke benchmark suite against that local backend. Do not pass a hard-coded localhost port to the benchmark command; point it at the same base URL `run.sh` is already serving.

```bash
# Run smoke benchmarks against local backend
cd "$(git rev-parse --show-toplevel)/agents" && source venv/bin/activate
BENCHMARK_BASE_URL=$SMOKE_BASE_URL \
  python benchmarks/run_benchmark.py --suite smoke --ci --parallel
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

Wait for **all** PR checks to finish — not just CodeRabbit. Poll every 30 seconds:

```bash
gh pr checks <PR_NUMBER> --json name,state
```

Keep waiting until every check has a terminal state (`SUCCESS`, `FAILURE`, `CANCELLED`, `SKIPPED`, `ERROR` — anything other than `PENDING` or `IN_PROGRESS`). **No timeout — keep waiting.**

Once all checks have completed, read reviews from ALL three comment locations:
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
