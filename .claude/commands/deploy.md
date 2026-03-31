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

**Use a background sub-agent** to poll for the CodeRabbit check — do NOT poll in the main context. Launch an Agent with `run_in_background: true` that:
1. Polls `gh pr checks <PR_NUMBER> --json name,state` every 30 seconds until the "CodeRabbit" check reaches `SUCCESS` state. **No timeout — keep waiting.**
2. Once CodeRabbit completes, reads reviews from ALL three comment locations:
   ```bash
   gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
   gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
   gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
   ```
3. Returns the full review content back to the main context.

While the sub-agent polls, you are free to do other work. When notified of completion, continue to Step 4.

## Step 4: Handle review results

Look across all three endpoints for review feedback from CodeRabbit. It may post findings as formal reviews or regular comments.

- **APPROVED** with no critical issues → proceed to Step 5.
- **CHANGES_REQUESTED** or any comment flagging **critical** issues → fix them, push, go back to Step 3.
- **No critical issues found** → proceed to Step 5.

Skip menial/style nits. Focus on correctness, bugs, and security issues.

**Reply to every review comment** before proceeding. For each comment, reply with one of:
- `[FIXED] <short solution description>` — if you fixed the issue
- `[IGNORED] <reason>` — if you're skipping it (style nit, not applicable, etc.)

Use `gh api` to post replies:
```bash
# Reply to a pull request review comment (inline code comment)
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies -f body="[IGNORED] style nit"

# Reply to an issue comment (regular PR comment)
gh api repos/{owner}/{repo}/issues/comments/<COMMENT_ID> -X PATCH -f body="<original body>\n\n[IGNORED] style nit"
```

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
