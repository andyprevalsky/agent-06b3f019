---
description: "Push current branch, wait for PR review to pass, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, wait for Claude Code Review, merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

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

Poll every 30 seconds until **both** the "Claude Code Review" and "CodeRabbit" checks complete. **No timeout — keep waiting.**

```bash
gh pr checks <PR_NUMBER> --json name,state,conclusion
```

Once completed, read reviews from ALL three comment locations (bots may use any of them):

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

## Step 4: Handle review results

Look across all three endpoints for review feedback from **both** Claude Code Review and CodeRabbit. Both bots may post findings as formal reviews or regular comments.

- **Both APPROVED** with no critical issues → proceed to Step 5.
- **CHANGES_REQUESTED** or any comment flagging **critical** issues (from either bot) → fix them, push, go back to Step 3.
- **No critical issues found** → proceed to Step 5.

Skip menial/style nits from either bot. Focus on correctness, bugs, and security issues.

## Step 5: Merge

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

Switch back to main and pull:
```bash
git checkout main && git pull origin main
```

## Step 6: Wait for deploys

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

## Step 7: Done

Report to the user:
- PR URL
- Which services were deployed
- Any review issues that were fixed along the way
