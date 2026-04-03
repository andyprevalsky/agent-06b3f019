---
description: "Push current branch, wait for PR review to pass, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, wait for CodeRabbit review, merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

## Step 0: Lint and format

Run the linter and formatter on all files that have been modified on this branch (compared to `main`):

```bash
cd back-end
CHANGED_TS=$(git diff --name-only main...HEAD -- 'back-end/src/**/*.ts' | sed 's|^back-end/||')
```

If there are changed `.ts` files:

1. Format them:
   ```bash
   npx prettier --write $CHANGED_TS
   ```
2. Lint and auto-fix:
   ```bash
   npx eslint --fix $CHANGED_TS
   ```
3. Check for remaining lint errors:
   ```bash
   npx eslint $CHANGED_TS
   ```

If there are remaining errors, fix them. Loop until `npx eslint` reports 0 errors on the changed files.

If any files were modified by this step, stage and commit them:
```bash
git add -p  # review changes
git commit -m "style: auto-format and lint fixes"
```

## Step 1: Prepare the branch

1. Check `git status` for uncommitted changes. If there are any, stage and commit them with a descriptive message.
2. If on `main`, create a new branch first:
   ```bash
   git checkout -b <descriptive-branch-name>
   ```
3. Push the branch:
   ```bash
   git push -u origin $(git branch --show-current)
   ```

## Step 2: Create PR

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

## Step 3: Wait for code reviews

Poll `gh pr checks <PR_NUMBER> --json name,state` every 30 seconds until the "CodeRabbit" check reaches `SUCCESS` state. **No timeout — keep waiting.**

Once CodeRabbit completes, read reviews from ALL three comment locations:
```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

## Step 4: Handle review results

Look across all three endpoints for review feedback from CodeRabbit. It may post findings as formal reviews or regular comments.

- **APPROVED** with no critical issues → proceed to Step 4b.
- **CHANGES_REQUESTED** or any comment flagging issues → fix them, push, go back to Step 3.
- **REVIEW SKIPPED** (e.g., "Too many files!") → **STOP and escalate to the user.** Do NOT proceed to merge. Tell the user CodeRabbit skipped the review, explain why (file count, etc.), and ask how they want to proceed (e.g., filter paths, split PR, or merge without review).
- **No issues found** → proceed to Step 4b.

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

## Step 4b: Pre-flight checks

Before merging, run these checks locally to ensure nothing is broken:

```bash
cd back-end

# 1. TypeScript compilation
npx tsc --noEmit

# 2. ESLint on changed files
CHANGED_TS=$(git diff --name-only origin/main...HEAD -- 'back-end/src/**/*.ts' | sed 's|^back-end/||')
npx eslint $CHANGED_TS

# 3. Prettier on changed files
npx prettier --check $CHANGED_TS

# 4. Structural tests (no server needed — static analysis)
npm run test:structural

# 5. Blackbox tests (start backend if not running, run tests, stop backend)
npx tsx watch src/server.ts &
# Wait for backend to be ready
for i in $(seq 1 30); do curl -s http://localhost:3001/health > /dev/null 2>&1 && break; sleep 1; done
npm run test:api
lsof -ti :3001 | xargs kill -9 2>/dev/null
```

If any check fails, fix the issue, commit, push, and go back to Step 3.

## Step 5: Archive plan (if applicable)

Before merging, check if there's an active plan related to this branch's work:

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

## Step 6: Merge

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

## Step 7: Wait for deploys


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
2. If fixable, create a new fix commit, push, and loop back to Step 3 (new review cycle)

## Step 8: New branch

Run `/new_branch_with_context` to sync with main and create a new branch so we can keep working.

## Step 9: Done

After the new branch is created, report to the user:
- PR URL
- Which services were deployed
- Any review issues that were fixed along the way
- The new branch name
