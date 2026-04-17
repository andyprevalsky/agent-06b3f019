# Refactor Plan

A generalizable playbook for taking a single repo (or a set of repos) through a full safety-net → layered-architecture → typed → coverage-gated refactor using Claude Code skills.

## Reading this DAG
Nodes at the same level with no arrows between them are **parallel siblings** (run simultaneously in separate Conductor workspaces). Arrows (↓) indicate **causal dependencies** — the child cannot start until the parent completes. Each node names the skill or manual action required.

"Repo" below means the unit of refactor — either a standalone codebase or a subdirectory in a mono-repo. Steps marked "per repo" run once per unit.

---

## Level 0 — Unblocking Prerequisite

### 0.1 Create Repo Scaffold (manual setup)
- Decide scope: single repo vs. mono-repo (use a mono-repo when refactoring multiple related codebases together).
- For mono-repo: create the root, `git subtree add` each codebase as a subdirectory.
- Add `.gitignore`.
- Add root `package.json` (or framework equivalent) with workspace scripts.
- Remove any build artifacts (`dist/`, `build/`, etc.) that are checked in.

**Output:** scaffold with all target codebases present and buildable.

---

## Level 1 — Tooling Foundation (parallel, all depend on 0.1)

### 1.1 `conductor.json` + `run.sh` (manual)
- **conductor.json:** setup (install all deps + post-install + initial build); run → `bash scripts/run.sh`.
- **run.sh services:** one job per app/service in the repo, plus centralized local dependencies (DB, queue, etc.).
- **Optional simulators/emulators (iOS, Android, etc.):** pre-flight check, boot in setup, launch in run, cleanup in EXIT trap.
- **Log paths:** `<repo>/<repo>-logs.log` per service.

**Output:** `conductor.json` + `scripts/run.sh` working.

### 1.2 Env Documentation (manual)
Create `.env.example` for each repo, covering every env var the service reads.
**Output:** one example file committed to each repo.

### 1.3 Port Skills (copy + adapt)
Skills to port:
- `/deploy` (progressive gates) — discover test suites at runtime, run what exists, flag what's missing, proceed
- `/push`
- `/sync`
- `/rename`
- `/new_branch_with_context`
- `/generate-claude-md`
- `/map-domains`
- `/create-domain-blackbox-tests`
- `/setup-formatter-and-linter`
- `/refactor-domain-for-full-autonomy`
- `/create-structural-tests`
- `/audit-providers-and-utils`
- `/enforce-canonical-utility`

**Output:** `.claude/skills/*.md` at the repo (or mono-repo) root.

### 1.4 CodeRabbit Setup (manual config)
- Create `.coderabbit.yaml` at the root.
- Path instructions per subdirectory.
- Skip detection enabled.

**Output:** `.coderabbit.yaml` + CodeRabbit app account wired to the repo.

---

## Level 2 — Infrastructure (parallel, depend on 1.1 + 1.2 + 1.3)

### 2.1 Generate Root CLAUDE.md
`/generate-claude-md`

Scan all repos/subdirs and generate a token-efficient table of contents anchoring architecture, entry points, test commands, and coding guidelines. Must include a Log Files section mapping `run.sh` per-job paths and any prod log sources. Also expand each per-repo `CLAUDE.md` beyond skeletal architecture notes.

**Output:** root `CLAUDE.md` + expanded per-repo `CLAUDE.md`.

### 2.2 CI/CD Improvements (manual + GitHub Actions)
For each repo with existing CI:
- Improve the existing deploy workflow.
- Add CodeRabbit check gate.
- Add test coverage reporting.
- Add `.env.example` validation.

**Output:** CI/CD hardened per repo.

---

## Level 3 — Domain Discovery (parallel, depend on Level 2)

### 3.1 Map Domains (per repo)
`/map-domains on <repo>/`

Discovers domain clusters appropriate to the framework — e.g., Express route + controller + model groupings on the backend; screen + hook + state-slice + service groupings on the frontend. Outputs a prioritized domain list with file mappings.

**Note:** native/compiled files (Swift, ObjC, Kotlin, etc.) are typically NOT in scope for a JS/TS refactoring pipeline — they route to native build jobs only.

**Output:** `domain-map.json` per repo.

---

## Level 4 — Per-Repo Refactoring Pipeline
Instantiated per repo (N parallel instances, one per repo in scope). Within each repo, `/batch` parallelizes across all domains discovered in Level 3.

### Step 4.A — Parallel siblings

#### 4.A.1 Create Blackbox Tests
`/batch /create-domain-blackbox-tests` (all domains in this repo)
Build behavioral safety net for each domain. Make sure all tests are passing on current code.
**Output:** all domains have behavioral safety net, tests green.

#### 4.A.2 Setup Formatter + Linter
`/batch /setup-formatter-and-linter` (all domains in this repo)
Configure fmt + lint rules for each domain. **DO NOT** auto-run the formatter across the codebase at this stage — 4.C will rewrite these files anyway, so mass reformatting now just creates a huge throwaway diff. Install configs, wire up the `lint-check.sh` script, add cleaned domains to the strict ratchet, and leave violations to be resolved during `/refactor-domain` in step 4.C.

### Step 4.B — Deploy (first checkpoint)
`/deploy` — ✅ lint ✅ fmt ✅ blackbox 🔴 E2E 🔴 structural 🔴 types
→ Push → PR → CodeRabbit → fix review comments → merge
**Output:** safety net + formatting landed on main.

### Step 4.C — Refactor Domains for Full Autonomy
`/batch /refactor-domain-for-full-autonomy` (all domains in this repo)
Refactor each domain into layered architecture adapted to the repo's framework. The skill reads the codebase and determines the right layer structure (Route→Controller→Service→Repository for Express, Screen→Hook→Service for React, etc.). Blackbox tests from 4.A.1 are the safety net — refactoring must not break them. Run continuously during refactor.
**Output:** all domains in layered architecture, all tests pass.

### Step 4.D — Deploy (second checkpoint)
`/deploy` — ✅ lint ✅ fmt ✅ blackbox ✅ E2E 🔴 structural 🔴 types → Push → PR → CodeRabbit → merge

### Step 4.E — Create Structural Tests
`/batch /create-structural-tests` (all domains in this repo)
Enforce the layered architecture invariants from 4.C with machine-readable tests. Generates tests that fail on boundary violations (e.g., a service importing express, a route containing business logic, etc.).
**Output:** architectural invariants machine-enforced, fail CI on violation.

### Step 4.F — Deploy (third checkpoint — structural tests gated)
`/deploy` — ✅ lint ✅ fmt ✅ blackbox ✅ E2E ✅ structural 🔴 types → Push → PR → CodeRabbit → merge

### Step 4.G — JS → TS Conversion
`/refactor-domain` (with TS migration flag) — **skip this step entirely if the repo is already TypeScript.**

**Step 1 — Setup** (once per repo, first domain only):
- Add `tsconfig.json` (strict: false initially)
- Install `@types/*` packages
- Configure test runner for `.ts`/`.tsx`

**Step 2 — Mechanical rename:**
- Rename domain `.js` → `.ts`/`.tsx`
- Add `: any` to untyped params (makes it compile)
- Fix import paths, verify all tests pass

**Step 3 — Tighten types:**
- Replace `any` with real types on public interfaces
- Leave internal `any` for now — tighten incrementally

Safety net: blackbox + structural tests catch regressions.
**Output:** domain is TypeScript, compiles, all tests pass.

### Step 4.H — Deploy (fourth checkpoint — type check gated)
`/deploy` — ✅ lint ✅ fmt ✅ blackbox ✅ E2E ✅ structural ✅ `tsc --noEmit` 🔴 coverage (coming in 4.M) → Push → PR → CodeRabbit → merge

### Step 4.I — Audit Providers and Utils
`/audit-providers-and-utils`
Scan shared utility/provider directories for boundary violations, misplaced business logic, duplicated code, and orphaned types. Move files to their proper layers. Keep only true cross-cutting utilities in the utils directory.
**Output:** utils are actually utilities, everything else is in its proper layer.

### Step 4.J — Deploy
`/deploy` — all existing gates pass → Push → PR → CodeRabbit → merge

### Step 4.K — Enforce Canonical Utility
`/enforce-canonical-utility`
Add ESLint `no-restricted-syntax` rules to ban hand-rolled patterns for cross-cutting concerns (logging, error handling, data access, storage, HTTP clients). CI fails on violation.
**Output:** canonical utilities enforced via lint rules.

### Step 4.L — Deploy (repo fully complete)
`/deploy` — all gates green for this repo: ✅ lint (+ canonical) ✅ fmt ✅ blackbox ✅ E2E ✅ structural ✅ type check → Push → PR → CodeRabbit → merge
**Output:** this repo is DONE. Move to code coverage (4.M).

---

## Level 4 — Per-Repo Cross-Cutting (after each repo's pipeline completes)

### 4.M Enforce Code Coverage (per repo)
`/enforce-code-coverage <starting-threshold>` — configure coverage thresholds per domain. Start at whatever the repo currently hits (ratchet only upward from there). Add coverage gate to CI.

Run once per repo.

---

## Level 5 — Bug Bash + Regenerate (after all Level 4)

### 5.1 Joint Team Bug Bash + Manual Fix
The dev team and the refactor team walk through each refactored domain together. Identify any regressions, broken flows, or architectural inconsistencies the automated pipeline missed. Fix issues manually as a team — this is also a teaching moment for how to use the skills going forward.

### 5.2 Regenerate CLAUDE.md
`/generate-claude-md`
Re-scan all repos now that they have layered architecture, TS, structural tests, coverage gates, and bug bash fixes applied.
**Output:** CLAUDE.md reflects the final refactored codebase state.

---

## Level 6 — Handoff (depends on Level 5)

### 6.1 Live Code Development Session
Video call with the dev team.
- Demo: pick a ticket, `/new_branch_with_context`, implement feature, `/deploy` end-to-end
- Show: Conductor multi-workspace parallelism
- Show: CodeRabbit review cycle
- Walk through CLAUDE.md and how to maintain it

**Output:** team can operate independently with the delivered skills.

### 6.2 Final Deliverables
Compile and deliver:
1. Claude Code skills (deployed to `.claude/skills`)
2. Linter/formatter/review config files + recommendations doc
3. This refactor roadmap (updated with actual results)

**Output:** all deliverables transferred.

---

## Skill Execution Guidelines

### `/batch`
- **Always pass explicit instructions to use general-purpose agents.** Do not let `/batch` fall back to specialized subagents for refactor work — the refactor skills assume a general-purpose agent's toolset and judgment.
- **PRs spawned by `/batch` merge back into the current branch, NOT `main` directly.** Each child PR from a `/batch` run should target the branch `/batch` was invoked from so the parent can review the aggregate diff before promoting it to `main` via `/deploy`. Never let a `/batch`-spawned PR auto-merge into `main`.
- Use pools of 10 agents — one per domain within the repo — for the domain-parallel skills below.

### `/map-domains`
Ensure domain boundaries match the invariants described in the Harness Engineering framework — domains should be self-contained, with minimal cross-domain file sharing.

### `/create-domain-blackbox-tests`
- Use `/batch` with pools of 10 agents — one per domain within the repo.
- Make sure all tests are passing on current code.

### `/setup-formatter-and-linter`
Linter config gets set up but remaining lint violations are NOT enforced as blocking until `/refactor-domain` resolves them in step 4.C.

### `/refactor-domain-for-full-autonomy`
Use `/batch` with pools of 10 agents — one per domain within the repo.

### `/create-structural-tests`
Use `/batch` with pools of 10 agents — one per domain within the repo.

---

## Out of Scope

The following are explicitly outside the scope of this playbook. They are natural follow-on work once the refactor is complete.

**Cloud-Triggered Agents** — Agents that trigger off ticket-tracker events (Linear, Jira), Slack messages, or GitHub issues to drive feature development end-to-end. Requires webhook integration, agent orchestration infrastructure (Temporal or similar), and a hosted agent runtime. This playbook delivers the skills these agents would use (deploy, refactor, test gen) but not the agent infrastructure itself.

**Background Garbage-Collection Agents** — Continuously running agents that comb the codebase to improve code quality, consistency, documentation, and test coverage without human initiation. Requires a hosted agent runtime with cron scheduling, cost-control (token budgets), and a review/approval workflow for autonomous PRs. The refactored codebase and structural tests from this playbook make GC agents dramatically more effective — they can operate within the enforced architectural boundaries rather than generating drift.
