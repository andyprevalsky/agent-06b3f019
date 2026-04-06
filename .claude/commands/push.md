---
description: "Fast-track merge to main for high-trust changes. Runs local tests (no smoke benchmarks), pushes, and merges directly — no PR or CodeRabbit review."
---

# Push

Fast-track merge to main. Runs local validation tests, pushes directly to main, no PR.

**When to use:** High-trust changes — benchmark harness tweaks, skill edits, config changes, small fixes where full deploy ceremony is overkill.

**When NOT to use:** Backend API changes, agent workflow changes, frontend changes, anything that touches prod user flows. Use `/deploy` for those.

---

## Step 1: Run local tests

All commands run from repo root. Compute changed files once:

```bash
CHANGED_TS=$(git diff --name-only main...HEAD -- 'back-end/src/**/*.ts' | sed 's|^back-end/||')
```

### 1a. Prettier (skip if no TS changes)

```bash
cd back-end && npx prettier --write $CHANGED_TS
```

### 1b. ESLint (skip if no TS changes)

```bash
cd back-end && npx eslint --fix $CHANGED_TS
cd back-end && npx eslint $CHANGED_TS
```

### 1c. TypeScript type check (skip if no TS changes)

```bash
cd back-end && npx tsc --noEmit
```

### 1d. Structural tests (skip if no TS changes)

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

### 1e. Blackbox API tests (skip if no back-end/ changes)

Spin up an isolated backend, run tests, tear down:

```bash
export SMOKE_PORT=4501
cd back-end && DISABLE_GMAIL_SYNC=1 PORT=$SMOKE_PORT npx tsx watch src/server.ts &
BACKEND_PID=$!
for i in $(seq 1 30); do curl -s http://localhost:$SMOKE_PORT/health > /dev/null 2>&1 && break; sleep 1; done

TEST_BASE_URL=http://localhost:$SMOKE_PORT npm run test:api

lsof -ti :$SMOKE_PORT | xargs kill -9 2>/dev/null || true
```

If any step fails, fix the issue and re-run from the top.

Stage and commit any auto-fix changes (prettier, eslint) before proceeding.

## Step 2: Sync

Run `/sync` before merging.

## Step 3: Merge to main

```bash
git checkout main
git pull origin main
git merge --no-ff $(git rev-parse --abbrev-ref @{-1}) -m "merge: <short description of changes>"
git push origin main
```

If on main already (linear commits), just push:
```bash
git push origin main
```

## Step 4: New branch

Run `/new_branch_with_context` to sync with main and create a fresh branch for the next task.

## Step 5: Done

Report what was pushed (files changed, commit summary) and the new branch name.
