---
description: "Fast-track merge to main for high-trust changes. Runs local tests (no smoke benchmarks), pushes, and merges directly — no PR or CodeRabbit review."
---

# Push

Fast-track merge to main. Runs local validation tests, pushes directly to main, no PR.

**When to use:** High-trust changes — benchmark harness tweaks, skill edits, config changes, small fixes where full deploy ceremony is overkill.

**When NOT to use:** Backend API changes, agent workflow changes, frontend changes, anything that touches prod user flows. Use `/deploy` for those.

---

## Step 1: Sync

Run `/sync` first — pulls the latest `main` into the current branch so local `main` isn't stale (otherwise `main...HEAD` diffs are wrong and you might re-push commits that are already upstream).

## Step 2: Run local tests

All commands run from repo root. Compute changed files once:

```bash
CHANGED_TS=$(git diff --name-only main...HEAD -- 'back-end/src/**/*.ts' | sed 's|^back-end/||')
CHANGED_FRONTEND=$(git diff --name-only main...HEAD -- 'front-end/**' || true)
CHANGED_MAC_APP=$(git diff --name-only main...HEAD -- 'mac-app/**' || true)
CHANGED_RESEARCH=$(git diff --name-only main...HEAD -- 'research/' || true)
```

### 2a. Prettier (skip if no TS changes)

```bash
cd back-end && npx prettier --write $CHANGED_TS
```

### 2b. ESLint (skip if no TS changes)

```bash
cd back-end && npx eslint --fix $CHANGED_TS
cd back-end && npx eslint $CHANGED_TS
```

### 2c. TypeScript type check (skip if no TS changes)

```bash
cd back-end && npx tsc --noEmit
```

### 2d. Structural tests (skip if no TS changes)

```bash
cd back-end && npx tsx src/tests/structural/layer-deps.test.ts
```

### 2e. Back-end code coverage (skip if no back-end/ changes)

```bash
cd back-end && npm run test:coverage
```

### 2f. Front-end code coverage (skip if no front-end/ changes)

```bash
cd front-end && npm run test:coverage
```

### 2g. Agents code coverage (skip if no agents/ changes)

```bash
cd agents && bash scripts/run-coverage.sh
```

Coverage must meet the `fail_under` threshold in `agents/pyproject.toml` (`[tool.coverage.report]`). Threshold ratchets toward 80%.

### 2h. Blackbox API tests (skip if no back-end/ changes)

The blackbox runner auto-starts an isolated backend on a dedicated port:

```bash
cd back-end && bash scripts/run-blackbox-tests.sh
```

### 2i. Mac-app code coverage (skip if no mac-app/ changes)

```bash
cd mac-app && npm run test:coverage
```

Coverage must meet the thresholds configured in `mac-app/vitest.config.ts`. Thresholds ratchet toward 80%.

### 2j. Mac-app blackbox tests (skip if no mac-app/ changes)

Runs vitest + MSW + jsdom across every renderer and main-process domain. Self-contained — no backend required.

```bash
cd mac-app && bash scripts/run-blackbox-tests.sh
```

**ALL domains must pass — 0 failures.** Same rule as the backend blackbox: pre-existing is not an excuse, fix every failure.

### 2k. Research lint + structural (skip if no research/ changes)

Runs deno fmt/lint (base + strict overlay), structural invariants (file/function length), and ruff for Python:

```bash
cd research && bash scripts/lint-check.sh
```

If it fails, re-run with `--fix` to auto-apply format/lint fixes, then re-verify:

```bash
cd research && bash scripts/lint-check.sh --fix
cd research && bash scripts/lint-check.sh
```

If any step fails, fix the issue and re-run from the top.

Stage and commit any auto-fix changes (prettier, eslint) before proceeding.

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

## Required factory execution metadata

Follow `docs/factory-telemetry.md` for every new factory run. Record exact
model/provider, effort, speed/service tier, harness/version, scoped token/cache
usage and cost, worker attribution, resource/concurrency context, disjoint wait
times and validation provenance. Every known value requires a timestamped source;
unavailable values stay explicitly unknown. Never guess historical settings or
publish raw transcripts, secrets or signed URLs. Set `FACTORY_METADATA_FILE`
before collection, append snapshots for changes and publish the ledger. Final
scorecards report model/effort/tier and collection gaps alongside timings.
