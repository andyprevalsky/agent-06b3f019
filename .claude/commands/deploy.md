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
ESCAPED_WORKSPACE_PATH=$(printf "%s" "$PWD" | sed "s/'/''/g")
ESCAPED_BRANCH=$(printf "%s" "$(git branch --show-current)" | sed "s/'/''/g")
ORIGINAL_WORKSPACE_TITLE="$(sqlite3 "$HOME/Library/Application Support/com.conductor.app/conductor.db" \
  "SELECT pr_title FROM workspaces WHERE workspace_path = '$ESCAPED_WORKSPACE_PATH' AND branch = '$ESCAPED_BRANCH' LIMIT 1;")"
echo "ORIGINAL_WORKSPACE_TITLE=$ORIGINAL_WORKSPACE_TITLE"
```

If `ORIGINAL_WORKSPACE_TITLE` is empty, continue deploy but skip the final Step 14a rename.

---

# Phase 1: Test Loop

**DEFAULT RULE: 100% of tests must pass before proceeding to Phase 2.** "Pre-existing failure", "not related to my changes", "performance issue", "local resource contention", and "flaky test" are not automatic excuses. If a test fails, fix it or stop and ask the user unless the user explicitly overrides that specific gate under the policy below.

## Explicit user gate overrides (highest-precedence deploy rule)

An explicit user message may override **any** `/deploy` gate, including tests,
coverage, credential health, smoke benchmarks, review, merge readiness, or
post-deploy verification. This section takes precedence over every contrary
"must pass", "no skip", "do not proceed", or "stop" instruction elsewhere in
this command.

An override is valid only when the user clearly identifies the gate or failure
being overridden and explicitly directs the agent to skip, override, proceed,
merge, ship, or go despite it. Admin status alone and ambiguous encouragement
are not overrides; a concrete message such as "skip the Anthropic credential
test and go" is. Never infer an override from silence or from approval of an
unrelated change.

When a gate is overridden:

1. Continue immediately without asking for duplicate confirmation.
2. Record `⚠️ Overridden` in `TEST_REPORT`, the exact gate/failure, and a concise
   paraphrase of the user's approval. Never misreport an overridden gate as
   passing.
3. Run every remaining non-overridden gate. An override is narrow unless the
   user explicitly makes it broader.
4. Include the override and its concrete risk in the PR body and final handoff.
5. Use a gate-specific harness override when one exists. For the Anthropic
   credential probe, set
   `DEPLOY_GATE_OVERRIDES=credential-health:anthropic`; this skips only that
   provider check and leaves all other credential checks active.

Gate approval does not authorize unrelated destructive actions, purchases, or
secret disclosure; those still require their own authority.

Start one durable timing run before the first gate. Every timed command below tees its console output to a per-stage log and atomically appends status + wall duration to the run timeline, so parallel verifier writes are safe:

```bash
bash scripts/run-deploy-stage --start
```

Artifacts land under `.context/deploy-runs/<run-id>/`. `bash scripts/run-deploy-stage --summary` prints the active run, and `bash scripts/run-deploy-stage --history` prints successful-stage p50/p90 plus end-to-end spans from finalized runs (active/aborted runs are reported separately).

Every `record_factory_event.py` command in this workflow is a hard collection
gate. Run it as the exact standalone command shown, require exit 0 and its
`FACTORY_EVENT` confirmation line, and fix/retry the writer before continuing if
either is missing. Search output, quoted command text, and failed tool calls are
not telemetry.

**You must fix ALL non-overridden failing tests, even if they are not caused by the changes in this branch.** The deploy flow defaults to keeping main green. If a test was already broken before your branch, that is now your responsibility to fix before merging unless the user explicitly overrides that exact gate. This includes infrastructure issues, flaky tests, timeout tuning, missing credentials, third-party integration problems, and anything else.

Run all checks locally. If any step fails, fix the issue and re-run that step. If fixing required code changes, re-run the entire Test Loop from the top.

## Test Report Tracking

As you run each step in Phase 1, track the results in a `TEST_REPORT` variable. For each step, record:

- The step name
- Pass/fail status
- A brief summary of the output (e.g., "0 errors", "3 files formatted", "6/6 benchmarks passed")

Build the report as a markdown table:

```
| Step | Status | Summary |
|------|--------|---------|
| Prettier | ✅ Pass | 3 files formatted |
| ESLint | ✅ Pass | 0 errors |
| TypeScript | ✅ Pass | 0 errors |
| Structural Tests | ✅ Pass | All invariants hold |
| Blackbox API Tests | ✅ Pass | 12/12 tests passed |
| Smoke Benchmarks | ✅ Pass | 6/6 passed locally, `RESULTS: 6/6 passed`, run `runs/<...>.json` |
```

Carry this report forward into Phase 2 for use in the commit message and PR body.

## Step 0: Change detection + execution plan

**`/deploy` ALWAYS ships the ENTIRE worktree — every change present relative to `origin/main`, no exceptions.** This includes work you did not author: changes made by a concurrent agent sharing this worktree, pre-existing uncommitted edits, and any feature intermixed with yours. Do NOT stop to ask "these changes aren't mine / weren't part of my task." Do NOT try to isolate, cherry-pick, or exclude a subset onto a clean branch. The unit of deploy is the worktree, and everything in it is yours to carry through the gates and ship. The only reason to halt is a gate failure you cannot fix or a credential/billing escalation — never change ownership or scope. (Whoever ran `/deploy` is asserting the whole worktree is ready; the gates are what prove it.)

If the branch is behind `origin/main`, sync first (commit the worktree, then
`git merge origin/main`). Resolve conflicts keeping every feature, re-sync deps
(`npm install` + `npx prisma generate`; `pip install -r requirements.txt`), and
re-run the gates on the merged tree — then proceed. Step 0 derives the latest
main-sync delta from merge history so shared type changes introduced by either
this merge or an earlier `/sync` remain lint seeds.

All Phase 1 commands run from the repo root. Compute changed paths from the complete active worktree: committed branch changes, staged/unstaged tracked changes, and untracked non-ignored files. This prevents pre-commit deploy checks from incorrectly treating a dirty branch as unchanged.

```bash
BASE_REF="${DEPLOY_BASE_REF:-origin/main}"
SYNC_MERGES=$(
  for merge_commit in $(git rev-list --first-parent --merges "$BASE_REF"..HEAD); do
    second_parent=$(git rev-parse "$merge_commit^2")
    if git merge-base --is-ancestor "$second_parent" "$BASE_REF"; then
      echo "$merge_commit"
    fi
  done
)
SYNC_CHANGED=$(
  for merge_commit in $SYNC_MERGES; do
    git diff --name-only "$merge_commit^1" "$merge_commit"
  done
)
CHANGED=$({
  printf '%s\n' "$SYNC_CHANGED"
  git diff --name-only "$BASE_REF"...HEAD
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} | sort -u)
CHANGED_TS=$(
  echo "$CHANGED" | grep -E '^back-end/src/.*\.tsx?$' | sed 's|^back-end/||' |
    while IFS= read -r file; do
      [ -f "back-end/$file" ] && echo "$file"
    done || true
)
CHANGED_BACKEND=$(echo "$CHANGED" | grep -E '^(back-end/|scripts/run-bench-hub-poller$)' || true)
CHANGED_BACKEND_LINT_INPUTS=$(echo "$CHANGED" | grep -E \
  '^(package(-lock)?\.json|back-end/(package(-lock)?\.json|tsconfig[^/]*\.json|eslint\.config\.(mjs|js|cjs|ts)|prisma/schema\.prisma))$' || true)
LINT_TS="$CHANGED_TS"
if [ -n "$CHANGED_BACKEND_LINT_INPUTS" ]; then
  LINT_TS=$(find back-end/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print |
    sed 's|^back-end/||' | sort)
fi
CHANGED_AGENTS=$(echo "$CHANGED" | grep -E '^agents/' || true)
CHANGED_FRONTEND=$(echo "$CHANGED" | grep -E '^front-end/' || true)
CHANGED_MAC_APP=$(echo "$CHANGED" | grep -E '^mac-app/' || true)
CHANGED_CLOUDBENCH=$(echo "$CHANGED" | grep -E '^(scripts/(run\.sh|run-in-new-session\.py|run-bench-cloud|run-bench-fleet|run-predeploy-(cloud|local)|cloudbench-|lib/cloudbench-env\.sh|tests/cloudbench-)|agents/benchmarks/cloudbench_dependency_sync_test\.py)' || true)
CHANGED_RUNTIME_SURFACE=$([ -n "$CHANGED_BACKEND$CHANGED_AGENTS" ] && echo "yes" || echo "")
CHANGED_AGENTCARD_PAYMENT=$(echo "$CHANGED" | grep -E '^(back-end/(scripts/setup-benchmark-payment\.ts|src/domains/(agentcard|purchases|test-payment)/|src/providers/(agentcard/|card-provider/|purchaseCleanup\.ts|purchase-wallet-funding|wallet-funding\.ts))|agents/(benchmarks/|domains/request_payment_card/|tools/request_payment_card\.py)|front-end/src/features/test-payment/|scripts/(run\.sh|run-agentcard-lifecycle-task\.sh))' || true)

# Keep the aggregate coverage worker pool within this 14-core deploy host.
# Backend blackboxes and unit files overlap, so both pools count. An uncapped
# all-repo run starts 18+ workers and makes every lane slower.
BACKEND_BLACKBOX_WORKERS=4
BACKEND_UNIT_WORKERS=6
AGENTS_COVERAGE_WORKERS=6
FRONTEND_COVERAGE_WORKERS=4
MAC_COVERAGE_WORKERS=4
if [ -n "$CHANGED_BACKEND" ] && [ -n "$CHANGED_AGENTS" ]; then
  BACKEND_BLACKBOX_WORKERS=4
  if [ -n "$CHANGED_FRONTEND" ] && [ -n "$CHANGED_MAC_APP" ]; then
    BACKEND_BLACKBOX_WORKERS=5
    BACKEND_UNIT_WORKERS=2
    AGENTS_COVERAGE_WORKERS=3
    FRONTEND_COVERAGE_WORKERS=2
    MAC_COVERAGE_WORKERS=1
  elif [ -n "$CHANGED_FRONTEND$CHANGED_MAC_APP" ]; then
    BACKEND_UNIT_WORKERS=2
    AGENTS_COVERAGE_WORKERS=4
  else
    BACKEND_UNIT_WORKERS=4
    AGENTS_COVERAGE_WORKERS=6
  fi
elif [ -n "$CHANGED_BACKEND" ] && [ -n "$CHANGED_FRONTEND$CHANGED_MAC_APP" ]; then
  BACKEND_UNIT_WORKERS=4
fi
```

## Step 0p: Prompt human-approval guard (no skip — always runs)

Prompt modifications are high-risk behavior changes. **Any prompt modification MUST be approved by a human before deploy proceeds.** This includes system prompts, tool prompts, agent/skill instructions, `CLAUDE.md`, `.claude/commands/*.md`, prompt template files, strategy overrides, and prompt-related diff hunks.

**MANDATORY for EVERY human-approval request in this deploy (Step 0p, Step 0b, and any other escalation): link the file(s) under review.** Whenever you stop for human approval, present each affected item as a clickable `repo-relative/path:line` reference — one per file/hunk — so the human can open and read the exact code before approving. Pasting a snippet is not enough on its own; the link is required. An approval request without file:line links is incomplete — do not ask for approval until you have listed the precise files + line ranges to review.

**What "prompt modification" means — LLM-visible text, not file membership.** The rule reviews changes to what an LLM actually reads: prompt/instruction text baked in at compile time (system prompts, tool descriptions, skill/command instructions, tasks.json `prompt`/`description` fields, template files) AND text assembled at runtime (string-building logic, template interpolation, context-chunk selection, truncation — anything that changes the bytes an LLM ultimately sees). The guard script flags candidate FILES, which over-approximates: a validation helper, UI accessibility tweak, or state-handling fix inside a flagged file is NOT a prompt modification. When the guard fires:

1. Examine every flagged hunk and classify it: does it change (or change the construction of) text an LLM ever sees — at compile time or runtime?
2. If NO hunk changes LLM-visible text: state that determination in the deploy log (per file, one line on why it is code-behavior only), then pass the guard with the mandatory flag WITHOUT waiting for human approval. Record `Prompt Human Approval Guard | Pass | flagged files are code-behavior only (no LLM-visible text changed): <files>` in `TEST_REPORT`.
3. If ANY hunk changes LLM-visible text — or you are unsure (runtime string construction counts) — stop and request human approval for those hunks, **each presented as a clickable `path:line` link** (per the mandatory file-link rule above). Immediately before sending the request, run `python3 scripts/record_factory_event.py deploy approval-request prompt-approval`. When mixed, list which hunks need review (with links) and which are code-behavior-only so the human reviews only what matters.

**Operational gate maintenance is pre-authorized and MUST NOT block for human approval.** Changes limited to `.claude/commands/deploy.md` instructions that detect changed paths, select or invoke tests, record verification evidence, or tighten CI/deploy gates do not alter product or agent prompts. Classify those hunks as operational code behavior, rerun the guard with the mandatory flag immediately, and continue. Never stop an active implementation, RCA, benchmark, or deploy goal to ask permission for test-gate wiring.

Run the guard without the approval flag first:

```bash
bash scripts/run-deploy-stage prompt-approval -- bash scripts/check-prompt-human-approval.sh
```

If it passes, record `Prompt Human Approval Guard | Pass | no prompt edits detected` in `TEST_REPORT`.

If it fails, apply the classification above. For hunks that change LLM-visible text, stop and ask the human to review them, **linking each one as a clickable `path:line` reference** so they can open the file. Do not infer approval from silence, prior discussion, or the fact that the branch exists.

Human approval is scoped only to the prompt diff that exists when approval is requested. If LLM-visible text in any prompt, instruction, command, skill, or prompt-related file changes later — including changes made to fix tests or smoke benchmarks — re-run the guard without the approval flag, show the new prompt diff, and wait for fresh explicit approval before continuing. Later code-behavior-only changes to flagged files follow rule 2 above (classify, log, proceed).

After the human responds, first run `python3 scripts/record_factory_event.py deploy approval-decision approved` (or `rejected`). A rejection remains blocked. After an approval, rerun the guard with the mandatory flag:

```bash
bash scripts/run-deploy-stage prompt-approval -- bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) may satisfy the guard. Do not pass it until explicit human approval has been retrieved in this deploy flow for the current prompt diff. Record `Prompt Human Approval Guard | Pass | human approval retrieved for prompt edits` in `TEST_REPORT`.

## Step 0b: Agent recovery / terminal-behavior human-approval guard (no skip — always runs)

The prompt guard (Step 0p) only catches changes to **LLM-visible text**. It cannot catch a change to **agent control-flow semantics** — flipping a recoverable failure into a terminal one, deleting a recovery fall-through, or inverting a recovery-invariant test. Those are as consequential as a prompt change but invisible to a text-only gate, and **an automated test cannot validate that the new behavior is the correct product decision** (the author just updates the test to match — all green). Regression precedent: commit `500715a5f` turned every single-planned-task DAG failure into a terminal agent FAILED instead of continuing iteration, and shipped green because its blackbox test was rewritten to bless the new behavior.

This guard scans the narrow agent control-flow layer (`agents/loop/run_agent.py`, `agents/loop/dag_executor.py`, `agents/workflows/agent_workflow.py`) and its behavior tests (`agents/tests/blackbox/{workflow,dag_executor,workflow_determinism}.blackbox.py`) for **hunks that change recovery vs. terminal semantics** — status/reason literals (`error`/`failed`/`aborted`/`max_iterations`/`needs_llm`/`completed`/`paused`), `_handle_incomplete`/`_mark_failed`/`_mark_complete`/`run_agent(` fall-through, `continue_as_new`, or a recovery-invariant test assertion (`run_agent_calls`, "must not run", `recovers_via`, result-status dicts). Comment- and logging-only edits are stripped so they do not trip it.

Run the guard without the approval flag first:

```bash
bash scripts/run-deploy-stage agent-behavior-approval -- bash scripts/check-agent-behavior-approval.sh
```

If it passes (no watched-file change, or no recovery/terminal-semantics hunk), record `Agent Behavior Approval Guard | Pass | no agent-behavior changes detected` in `TEST_REPORT`.

If it fails, examine every flagged hunk. Unlike Step 0p there is no "code-behavior only" bypass — a flagged hunk **is** an agent-behavior change by construction. Stop and request explicit human approval for it — **presenting each hunk as a clickable `path:line` link** (per the mandatory file-link rule in Step 0p) — and state, in one line, how it changes when the agent gives up vs. keeps iterating. Immediately before sending the request, run `python3 scripts/record_factory_event.py deploy approval-request agent-behavior-approval`. Approval is snapshot-scoped exactly like the prompt gate: if later fixes add or change recovery/terminal hunks, re-run without the flag and request fresh approval. After the human responds, first run `python3 scripts/record_factory_event.py deploy approval-decision approved` (or `rejected`); a rejection remains blocked. After approval, rerun with the mandatory flag:

```bash
bash scripts/run-deploy-stage agent-behavior-approval -- bash scripts/check-agent-behavior-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) satisfies the guard. Record `Agent Behavior Approval Guard | Pass | human approval retrieved for agent-behavior edits` in `TEST_REPORT`.

**Execution model for Steps 1–4a (run in this order):**

1. **Prompt approval gate** (read-only, always first): Step 0p. If prompt edits are detected, stop until a human approves them, then rerun Step 0p with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change prompt/instruction files, return to Step 0p without the flag and request fresh approval for those additional prompt changes.
1b. **Agent-behavior approval gate** (read-only, runs alongside Step 0p): Step 0b. If recovery/terminal-semantics hunks are detected, stop until a human approves them, then rerun Step 0b with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change agent-behavior hunks, return to Step 0b without the flag and request fresh approval.
2. **Sequential mutators** (they write files — cannot parallelize): Step 1 (`prettier --write`) → Step 2a (`eslint --fix`) → Step 1m (`mac-app format + lint --fix`, skip if `CHANGED_MAC_APP` is empty). Commit any resulting changes once.
3. **Parallel Group 3** (all read-only after the mutators; start every applicable
   lane in one assistant message with separate Bash tool calls, using the worker
   budgets computed above). Every repository
   coverage command executes its blackbox suite under instrumentation, so that
   one command satisfies both the Coverage and Runtime blackbox rows. Never run
   the same blackbox suite again without coverage. Before the combined lanes,
   record their shared runtime wall-clock boundary:

   ```bash
   python3 scripts/record_factory_event.py deploy stage-start runtime-blackbox
   ```

   Then start static verification and every applicable combined
   coverage-blackbox command together. Do not start the Group 4 semantic/smoke
   workloads until Group 3 ends: their own worker pools oversubscribe the host
   and lengthen the critical path. The semantic stack no longer runs a duplicate
   backend blackbox suite.

   **Static verify:**
   - Step 2b: `eslint` verify (0 errors)
   - Step 3: `tsc --noEmit`
   - Step 4: structural tests (skip if `CHANGED_TS` is empty)
   - Step 4s: deploy environment + command structural tests (no skip)
   - Step 4m-lint: mac-app format:check + lint + type-check (skip if `CHANGED_MAC_APP` is empty)
   - Step 4cb: cloud benchmark controller regressions (skip if `CHANGED_CLOUDBENCH` is empty)

   **Coverage + Runtime blackbox (one execution, reported in both rows):**
   - Step 4a: back-end blackbox + unit tests under coverage (skip if
     `CHANGED_BACKEND` is empty)
   - Step 4b: front-end blackbox + structural tests under coverage (skip if
     `CHANGED_FRONTEND` is empty)
   - Step 4g: agents blackbox + fast-cache + unit tests under coverage (skip if
     `CHANGED_AGENTS` is empty)
   - Step 4m-coverage: mac-app blackbox tests under coverage (skip if
     `CHANGED_MAC_APP` is empty)

   After those parallel branches finish, run Step 4c's focused credential
   health probe and Step 4h's focused live Amplitude probe once each. Coverage
   intentionally keeps external providers offline; these focused tails preserve
   the real assertions without letting a provider retry rerun every repository
   suite.

   When every applicable runtime-blackbox branch ends, pass or fail, record:

   ```bash
   python3 scripts/record_factory_event.py deploy stage-finish runtime-blackbox
   ```

   A failure followed by a fix is a new lifecycle: emit a new start/finish pair
   around the rerun. Never leave a started runtime boundary unfinished. The
   factory report attributes each combined command to both semantic rows but
   unions it only once in Group 3 wall clock.

If any verifier fails, fix and re-run the full Step 0 → verifier flow. Do not proceed until all verifiers are green.

## Step 1: Prettier format

If `$CHANGED_TS` is non-empty, format them:

```bash
cd back-end && bash ../scripts/run-deploy-stage prettier -- npx prettier --write $CHANGED_TS
```

If any files were modified by this step, stage and commit them:

```bash
git add -p  # review changes
git commit -m "style: auto-format and lint fixes"
```

## Step 2: ESLint fix + verify

If `$LINT_TS` is non-empty, lint the changed back-end files and every
transitive reverse importer. Shared middleware, types, and configuration can
invalidate consumers that are not in the diff, so changed-file-only linting is
not a sufficient deploy gate. Changes to package manifests, TypeScript config,
or ESLint config set `$LINT_TS` to the entire source tree because those inputs
can change the meaning of every unchanged file.

**Step 2a (mutator — runs before the parallel verifier batch):**

```bash
cd back-end && bash ../scripts/run-deploy-stage eslint-fix -- node scripts/lint-affected.mjs --fix $LINT_TS
```

**Step 2b (verifier — runs in parallel with Steps 3, 4, 4a):**

```bash
cd back-end && bash ../scripts/run-deploy-stage eslint -- node scripts/lint-affected.mjs $LINT_TS
```

If there are remaining errors, fix them manually. Loop until the affected-file lint reports 0 errors.

**CRITICAL: You must reach 0 errors across every affected file. "Pre-existing" or "this error was already on main" is NOT an excuse to skip it.** This includes `no-console`, `no-explicit-any`, `strict-boolean-expressions`, `max-lines`, and any other rule. Fix them all.

If any files were modified by this step, stage and commit them (can combine with Step 1's commit if both ran together).

## Step 3: TypeScript type check

```bash
cd back-end && bash ../scripts/run-deploy-stage typescript -- npx tsc --noEmit
```

Catches type errors that ESLint misses (wrong argument types, missing properties, bad generics). Fix any errors before proceeding — pre-existing type errors in touched files are your responsibility.

## Step 4: Structural tests + fix

**Skip if `$CHANGED_TS` is empty** (structural invariants only apply to back-end TS changes).

```bash
cd back-end && bash ../scripts/run-deploy-stage backend-structural -- npx tsx src/tests/structural/layer-deps.test.ts
```

This enforces architectural invariants across all domains: import direction, cross-domain isolation, provider/util boundaries, domain completeness, Prisma/Express encapsulation, and circular import detection.

If any invariant fails, fix the violation. The test output includes remediation guidance (e.g., "Move the needed logic to service.ts or extract to a provider.").

## Step 4s: Deploy environment + command structural tests (no skip)

```bash
bash scripts/tests/workspace-env.test.sh
bash scripts/tests/semantic-deploy-gate.test.sh
bash scripts/tests/check-agent-behavior-approval.test.sh
python3 scripts/tests/factory-review.test.py
bash scripts/tests/run-deploy-stage.test.sh
```

These tests execute the workspace identity boundary with a stale Conductor display name and verify that the DB container, DB volume, and Temporal queue all use the normalized worktree identity. They also enforce that `/deploy` keeps this gate wired into every run. `check-agent-behavior-approval.test.sh` pins the Step 0b guard's detection logic (it fires on recovery/terminal-semantics hunks, passes on comment/logging noise and unwatched files).

## Step 4a: Back-end coverage + blackbox (skip if no back-end/ changes)

```bash
cd back-end && bash ../scripts/run-deploy-stage backend-coverage-blackbox -- \
  env BLACKBOX_TEST_CONCURRENCY="$BACKEND_BLACKBOX_WORKERS" \
      CONTRACT_TEST_CONCURRENCY="$BACKEND_BLACKBOX_WORKERS" \
      BACKEND_UNIT_CONCURRENCY="$BACKEND_UNIT_WORKERS" \
      npm run test:coverage
```

This one command runs all 91 deterministic back-end blackbox domains plus unit
tests under V8 coverage. It must both pass every test and meet
`back-end/.c8rc.json`; the real provider credential probe runs once in Step 4c.

## Step 4b: Front-end coverage + blackbox (skip if no front-end/ changes)

```bash
cd front-end && bash ../scripts/run-deploy-stage frontend-coverage-blackbox -- \
  npm run test:coverage -- --maxWorkers="$FRONTEND_COVERAGE_WORKERS"
```

This one command runs every front-end blackbox and structural Vitest under
coverage. Every test must pass and coverage must meet `front-end/vitest.config.ts`.
Never loosen the threshold or rerun the same blackbox suite separately.

## Step 4g: Agents coverage + blackbox (skip if no agents/ changes)

```bash
cd agents && bash ../scripts/run-deploy-stage agents-coverage-blackbox -- \
  env AGENTS_COVERAGE_CONCURRENCY="$AGENTS_COVERAGE_WORKERS" \
      bash scripts/run-coverage.sh
```

This one command runs every agents blackbox plus fast-cache and unit tests under
coverage. Every test must pass and coverage must meet `agents/pyproject.toml`.
Never loosen the threshold or rerun the blackbox suite separately.

## Step 1m: Mac-app format + lint auto-fix (skip if `$CHANGED_MAC_APP` is empty)

Sequential mutator — runs before the parallel verifier batch, same pattern as Step 1 (prettier) and Step 2a (eslint --fix) for the back-end.

```bash
cd mac-app && bash ../scripts/run-deploy-stage mac-format -- npm run format
cd mac-app && bash ../scripts/run-deploy-stage mac-lint-fix -- npm run lint:fix
```

Commit any resulting changes (can combine with Step 1's commit).

## Step 4m-lint: Mac-app format:check + lint + type-check (skip if `$CHANGED_MAC_APP` is empty)

Parallel verifier. Enforces the same 0-error bar as back-end Step 2b — "pre-existing" violations in the mac-app files you touched are your responsibility.

```bash
cd mac-app && bash ../scripts/run-deploy-stage mac-static -- bash -c 'npm run format:check && npm run lint && npm run type-check'
```

If any check fails, fix and re-run. `npm run lint` applies both base rules and the type-aware strict overlay defined by `STRICT_DOMAIN_FILES` in `mac-app/eslint.config.mjs` (max-lines, max-lines-per-function, no-floating-promises, strict-boolean-expressions, etc.).

## Step 4m-coverage: Mac-app coverage + blackbox (skip if `$CHANGED_MAC_APP` is empty)

```bash
cd mac-app && bash ../scripts/run-deploy-stage mac-coverage-blackbox -- \
  npm run test:coverage -- --maxWorkers="$MAC_COVERAGE_WORKERS"
```

This one command runs the complete mac-app Vitest/MSW/jsdom blackbox suite under
coverage. Every domain must pass and coverage must meet `mac-app/vitest.config.ts`.
Never loosen the threshold or launch `scripts/run-blackbox-tests.sh` afterward.

If the failure is renderer-only (jsdom + React), check `mac-app/tests/blackbox/test-wrapper.tsx` and the relevant MSW handlers in `mac-app/tests/blackbox/msw/handlers.ts`. If it's main-process (Node + Electron stubs), check `mac-app/tests/blackbox/electron-stubs.ts` and `mac-app/tests/blackbox/fetch-capture.ts`.

## Step 4cb: Cloud benchmark controller regressions (skip if `$CHANGED_CLOUDBENCH` is empty)

Cloud benchmark scripts own Fly lifecycle, local proxy ports, synchronized barrier release, and durable machine cleanup. When that surface changes, run the fast functional regression plus the focused lifecycle cases before any paid cloud run:

```bash
bash scripts/tests/cloudbench-env.test.sh
bash scripts/tests/cloudbench-acceptance-autoscale.test.sh
bash scripts/tests/cloudbench-multi-workstream.test.sh
agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py \
  -k 'cloud_patch_detection_and_payload_include_staged_only_changes or patch_delivery_clears_stale_base64_configuration or shared_patch_digest_is_pinned_and_verified or fleet_shared_patch_remains_authoritative_until_transport_selection or fleet_patch_packages_clean_unpushed_head_from_fetchable_base or declared_patch_payload_cannot_be_missing_or_empty or empty_local_patch_cleanup_is_nounset_safe or central_hub_runs_in_own_session_after_launcher_exit or boot_launch_delivers_the_exact_worktree_patch_to_every_guest or boot_launch_runs_the_current_driver_before_applying_the_patch or autoscaled_worker_failure_is_removed_and_replaceable or autoscaler_scale_down_cancels_pending_worker or fleet_registry_release_id_is_idempotent_with_other_records or refresh_deps_tracks_exact_created_snapshot or data_plane_proxies_retry_machine_dns_and_restart_if_lost or status_polled_over_data_plane_proxy_not_ssh or cloud_runner_avoids_live_run_port_collisions or fleet_barrier_reads_the_authoritative_rotated_status_port or data_plane_barrier_release_at_full_fleet_width or storage_readiness_inventory_reads_are_bounded or fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown or isolated_backend or local_predeploy_skips_wmh'
cd agents && python scripts/run_blackbox_tests.py benchmark
```

All four commands must pass. This operational verification wiring is pre-authorized by Step 0p and must never pause for human approval.

## Step 4c: Credential health check (runs unless explicitly overridden)

After all parallel Group 3 branches finish, validate every external credential
(E2B, Steel, Parallel.ai, Anthropic, OpenRouter, Supabase) with the focused test
below. The deterministic Step 4a batch excludes this provider-dependent domain,
so this runs exactly once and a provider outage can be retried without rerunning
all 91 instrumented back-end domains.

```bash
cd back-end && bash ../scripts/run-deploy-stage credential-health -- npx tsx src/tests/blackbox/integration-health.blackbox.ts
```

**If any hard credential is rejected** the error message names the exact env var to refresh and the provider dashboard URL. Escalate to the user immediately and do not proceed to Step 5 unless the user explicitly overrides that credential gate. If overridden, record the rejection as `⚠️ Overridden`, use the narrow gate-specific harness override, and continue every other check. Do not change production auth behavior merely to make a rejected credential appear healthy.

Anthropic/Claude is intentionally non-blocking in this gate: the probe should still run by default and report `WARN` on exhausted credits, rejected auth, or provider availability problems, but future deploys may proceed without human approval when only this provider fails. The optional `DEPLOY_GATE_OVERRIDES=credential-health:anthropic` path remains available when an operator wants an explicit audited skip instead of a live probe. Parallel.ai is also warn-only.

## Step 4h: Live Amplitude admin-health probe (no skip)

Run this once after all parallel Group 3 branches finish and before recording
the `runtime-blackbox` finish boundary:

```bash
cd back-end && bash ../scripts/run-deploy-stage amplitude-live -- \
  env ADMIN_HEALTH_LIVE_ONLY=1 BLACKBOX_TEST_CONCURRENCY=1 \
      bash scripts/run-blackbox-tests.sh admin-health
```

This starts an isolated local backend and executes only the strict weekly
admin-health case. Missing credentials fail closed; all six Amplitude funnel
steps must be `ready` with real counts. A 429 blocks deploy, but its rerun
repeats only this focused probe—not the complete coverage suite.

## Step 5: Spin up local services

**Step 5.0 (MANDATORY pre-flight garbage collection):** before spinning up anything, kill any stale run.sh trees + orphaned backend/worker/supabase processes from prior aborted runs in this worktree. This guarantees a clean local blackbox/semantic stack; cloud smoke uses separate task-scoped queues.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/list-services.sh           # inspect what's running (optional, informational)
bash scripts/kill-services.sh           # kill the whole tree; preserves DB container + volume
```

`scripts/kill-services.sh` is worktree-scoped (uses `$PWD` as the filter), walks descendants via `pgrep -P`, SIGTERMs then SIGKILLs survivors, and deliberately leaves the Postgres container intact. Re-run it any time you need a clean slate — it is idempotent.

Spin up the local stack through `scripts/run.sh --benchmark`. This stack serves
the Group 4 semantic gate; coverage commands already ran every repository
blackbox exactly once. Pre-Deploy smoke runs on its own separate isolated stack
via `run-bench --local` (or, opt-in, the cloud fleet). In benchmark mode,
`run.sh` starts `back-end`, `front-end`, and `agents`, and skips `mac-app`.

```bash
# Conductor provides the base port; run.sh fans out backend/frontend/health from it.
if [ -z "$CONDUCTOR_PORT" ]; then
  echo "CONDUCTOR_PORT must be set (run this from Conductor)." >&2
  exit 1
fi

DEPLOY_ROOT="$(git rev-parse --show-toplevel)"
. "$DEPLOY_ROOT/scripts/lib/workspace-env.sh"
. "$DEPLOY_ROOT/scripts/lib/deploy-local-env.sh"
configure_deploy_local_env

cd "$DEPLOY_ROOT"
```

**CRITICAL: Start the DB container BEFORE `run.sh` so that `run.sh` treats it as pre-existing and won't stop it on cleanup.** `run.sh` has an EXIT trap that stops all services it started — including the DB container. By pre-starting the DB, `run.sh` sees it as already running and skips DB cleanup, which prevents the DB from dying if `run.sh` exits for any reason (signal, child process exit, timeout, etc.).

```bash
# Step 1: Ensure DB is running BEFORE run.sh starts (so run.sh won't own/stop it)
if ! docker ps --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  if docker ps -a --filter "name=^${DB_CONTAINER}$" --format '{{.Names}}' | grep -q .; then
    docker start "$DB_CONTAINER" >/dev/null
  else
    docker run -d --name "$DB_CONTAINER" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=victoria \
      -p "$LOCAL_DB_PORT:5432" -v "$DB_VOLUME:/var/lib/postgresql/data" \
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
# Keep all service output redirected so the managed session cannot exhaust its output budget.
# run.sh will detect the DB as already-running and won't stop it on cleanup.
# Use run_in_background=true for this command:
BENCHMARK_BUNDLED_FRONTEND=true DISABLE_GMAIL_SYNC=1 \
  BENCHMARK_SKIP_WMH_BUILD=1 WORKER_PROCESSES=8 TRACE_ARCHIVE_ENABLED=0 \
  bash scripts/run.sh --benchmark > .context/deploy-smoke.log 2>&1
```

Poll the background Bash call at least every 30 seconds while Steps 5-6b run. This keeps the managed process session active without streaming the high-volume service logs; use `.context/deploy-smoke.log` only for targeted diagnosis. `BENCHMARK_BUNDLED_FRONTEND=true` builds and serves the frontend so the browser-agent lifecycle gates have a stable target.

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

`BENCHMARK_BUNDLED_FRONTEND=true` builds and serves the frontend through Vite preview as part of the managed `run.sh` tree. The bundled server is required for browser-agent lifecycle tests; the module-by-module development server is not reliable through the benchmark tunnel.

**Teardown (MANDATORY):** after Step 6b finishes (pass OR fail), and any time you abort the local gates mid-way, you MUST tear the stack down before moving on. Skipping this leaves zombie run.sh + grandchildren that leak ports, RAM, and worker slots across `/deploy` invocations.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/kill-services.sh                    # kills run.sh tree, preserves DB
```

`kill-services.sh` is a superset of the old `pkill -f "scripts/run.sh --benchmark"` approach: `pkill` only signals bash wrappers, so detached node/python grandchildren survive (the real root cause of the zombie-run.sh problem). `kill-services.sh` walks descendants explicitly. Use `scripts/teardown.sh` instead if you also want to delete the DB container + volume (destructive).

## Step 4d: Open the PR and launch parallel Group 4

The read-only static, coverage, and runtime-blackbox lanes in Group 3 are now
green. Commit all intended files, push, and open the PR using the Step 7/8 body
and title format. Persist `pr_title_locked` as described in Step 8. The push
starts CodeRabbit.

Immediately before the push, record the review lifecycle start:

```bash
python3 scripts/record_factory_event.py deploy stage-start code-review
```

Immediately after the PR exists, launch all applicable Group 4 lanes together
in one assistant message with separate parallel Bash tool calls:

1. Code review polling (Step 9).
2. Smoke benchmarks (Step 6; skip only under its documented classifier).
3. AgentCard lifecycle (Step 6a; skip only when its classifier is empty).
4. Semantic tests (Step 6b; never skip).

Matching Group 4 rows in `/factory-review` therefore share a real start phase.
Do not wait for one lane before starting another. All applicable lanes must be
green before merge. If any lane changes code, push the fix, restart the Test
Loop from Step 0, and relaunch the whole applicable Group 4 batch; the push
re-arms CodeRabbit.

By Phase 2, the push and PR already exist. Treat Steps 7 and 8 as “verify
already done” unless a failed test-loop iteration forced a restart.

## Step 6: Smoke benchmarks + fix

### When smoke can be skipped

Smoke benchmarks exercise the full agent runtime (backend API → Temporal → worker activities → in-process Rose LLM calls). Skip them **only** when the PR diff cannot possibly affect that runtime. Confirm by running `git diff --name-only main...HEAD` and checking every path against the table below.

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
| `scripts/run.sh`                                                                     | Service startup and env wiring that smoke depends on                                         |
| `back-end/.env.example` **when it adds a new required env var**                      | Runtime config contract change                                                               |

**Tie-breaker rule:** if a path touches both safe and must-run buckets, treat the diff as must-run. When in doubt, run smoke — or ask the user.

When skipping, record it explicitly in the Test Report:

```
| Smoke Benchmarks | ⏭️ Skipped | Diff is test-infra only (paths: <list>) — no runtime impact |
```

### Running smoke

Run the complete Pre-Deploy smoke group on the **LOCAL isolated benchmark stack** (the default). The Step 5 stack stays up for blackbox and semantic tests; `run-bench --local` spins up its OWN per-run isolated stack (separate backend + worker + WMH + Postgres), so the two never collide.

```bash
cd "$(git rev-parse --show-toplevel)"
bash scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-local
```

`scripts/run-predeploy-local` derives the task set from every catalog entry tagged `smoke` (identical selection to the cloud path, so they can't drift) and runs them through `scripts/run-bench --local` at max concurrency 2 on this machine. It orders tasks longest-recent-median first, using the pass ledger, to target a shorter two-lane idle tail without increasing simultaneous load. It exits non-zero unless every requested task passes, so the command IS the gate.

Every invocation tees its console output to `.context/predeploy-runs/<run-id>/runner.log` and writes actual start/end time, total wall duration, status, concurrency, task set, and schedule to `summary.json` beside it. Inspect the accumulated actual totals plus per-task pass history at any time:

```bash
bash scripts/run-predeploy-local --history
```

**Why local is the default:** the shared cloud fleet (`run-predeploy-cloud`, app `navi-whisper-lux-bench`) is frequently rate-limited, volume-capacity-starved, and — worst — **leaks paid Fly machines when the controller is killed** (a killed run orphans clones + autoscaler workers that keep billing until manually destroyed). Local has no shared-resource contention and no cross-workspace blast radius. Use the cloud fleet only as an explicit opt-in when local resources are insufficient:

```bash
# Opt-in cloud alternate (only when local can't run the set — e.g. many heavy browser tasks):
bash scripts/run-predeploy-cloud   # per-bench Fly fleet via the production Hub; verify the hub-... run in Benchmarks → Runs
```

If you DO run the cloud path, its gate is stricter surface (Hub dispatch `completed`, task set exactly matches the smoke group, every task `passed`) and you MUST actively monitor it and reap leaked machines on any abort (see rule #1 — never fire-and-forget an async task; `flyctl machines list -a navi-whisper-lux-bench` then `flyctl machine destroy --force` every non-warm/non-controller clone).

### Active-worktree contract

The local run tests exactly the working tree on this machine — the checked-out `HEAD` plus any staged/unstaged edits — so there is no fleet checkout or binary-patch step to worry about. Still:

- Step 4d commits all intended new/untracked files before runtime tests.
- Before starting smoke, fail if an intended untracked file remains; commit it and restart the Test Loop. Gitignored `.context/` artifacts do not count.

Timeout history remains catalog-driven on the checked-out ref. Do not fabricate or manually copy duration rows as part of deploy.

### Monitoring agent progress during smoke tests

**Do NOT fire-and-forget** (rule #1). Keep `scripts/run-predeploy-local` in the foreground (or, if backgrounded, actively poll it on the cadence below — the wake-up may never come). Monitor its console output and the per-run manifest + result JSON under `.context/benchmarks/<run-id>/`; each task prints an FE link (`http://localhost:<fe-port>/?agent-id=...`) you can open to verify the agent actually ran. (Cloud alternate only: monitor the printed Hub run in **Benchmarks → Runs**, `.context/hub-poller-run-<request-id>.log`, and `.context/fleet/runs/<batch-id>/_batch/report-card.json`, and reap leaked Fly machines on any abort.)

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

**ALL non-skipped Pre-Deploy smoke benchmarks must pass, with 0 failures.** The only deploy-approved smoke skip is a Claude Code benchmark whose preflight proves there are no synced Claude credentials and no pool token; the shared `ANTHROPIC_API_KEY` fallback is covered by the warn-only credential-health gate and does not satisfy this skippable smoke task. This provider-auth/funding state is skippable by future deploys without additional human approval. On the local path, `run-predeploy-local` must exit 0 and every non-skipped task's FE link must show the agent actually ran. (Cloud alternate: the Hub run must be final — `live=false`, dispatch `completed` — and visible in Benchmarks → Runs.) Timeouts, stalls, wrong tool usage, backend crashes, or any other failure mode must be diagnosed and fixed. You are expected to root-cause every failure and fix it in code. This is not optional — smoke failures are real bugs.

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
     — event-timeline tree across worker/backend/messages. Best
     for raw error context.
   - For full detail when the summary points at a layer:
     `agent_latency.py <agent_id> -v` for the full span tree, or
     `agent_logs.py <agent_id> --tree --source worker|backend|messages`
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
- Skipping or disabling tests, except the deploy-approved Claude Code credential-unavailable smoke skip described above

**Escalation is ONLY for:**

- Third-party providers returning error codes that indicate the account is out of credits/funds (e.g., "insufficient credits", "402", "quota exceeded")
- Authentication/OAuth token errors (e.g., "401", "authentication failed", "credentials expired") — these require the user to re-authenticate or provide fresh tokens. Do NOT work around auth errors in code; escalate to the user to retrieve valid tokens.

Everything else — crashes, timeouts, stalls, resource contention, infra issues — is your job to fix.

If a benchmark fails due to infrastructure (local stack flake, or on the cloud alternate a fleet/Fly issue), fix the runner and re-run the full smoke group. On the local path all tasks must pass in one `run-predeploy-local` invocation; on the cloud alternate a sequential diagnostic run does not satisfy the concurrent gate.

### Local cleanup

The fleet runner owns its Fly machines and stops/destroys them on every normal or trapped exit. After the command finishes, verify every ID in `.context/cloudbench-pool.ids` is `stopped` and that no fresh clone IDs recorded by the batch remain alive.

Failed benchmark agents are intentionally retained long enough for diagnostics. Do not delete them before collecting the three required diagnostic views. The local Step 5 stack is unrelated to cloud smoke and stays up until the local gates finish.

**Keep the local Step 5 stack running for Steps 6a and 6b. Run the Step 5 teardown only after both gates finish, or immediately when either gate fails.**

### Diagnosing failures

When any local smoke benchmark fails, start with the run artifacts before making code changes:

| Surface | Artifact                                                        | What to look for                           |
| ------- | --------------------------------------------------------------- | ------------------------------------------ |
| Runner  | `local.py` report card / `RESULTS:` line                        | which task failed + evaluator reason       |
| Result  | `agents/benchmarks/runs/<run>.json` + `runs/<run>_diagnostics/` | failed agent ID and failure_reason         |
| Worker  | `agents/navi-worker-log.txt`                                    | tracebacks, tool errors, LLM-call failures |
| Backend | `back-end/backend-logs.log`                                     | 500s, Prisma errors, route failures        |

For benchmark-specific diagnostics, run ALL three summaries in parallel — they answer different questions (LOCAL, so no `--prod` / `--url`):

```bash
# "Why was this slow/stalled?" — span waterfall + top-10 bad paths
cd agents && python benchmarks/agent_latency.py <agent_id>

# "What errors happened where?" — event-timeline tree
cd agents && python benchmarks/agent_logs.py <agent_id> --tree --diagnostics

# "How much did this cost / cache?" — tree-wide token + cache breakdown
cd agents && python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>
```

Expand the relevant one: `agent_latency.py <agent_id> -v` for the full span tree, or `agent_logs.py <agent_id> --tree --source worker|backend|messages` for per-source raw events.

## Step 6a: AgentCard sandbox lifecycle gate

Skip only when `$CHANGED_AGENTCARD_PAYMENT` is empty. Otherwise, start this as
one Group 4 lane alongside smoke, semantic, and code review. Its local benchmark
runner owns one isolated backend/frontend/worker/Postgres stack, so it never
tears down or contends with the shared Step 5 stack used by semantic tests.
The four payment tasks stay sequential inside this lane because they mutate one
payment fixture; top-level parallelism comes from running the lane alongside its
Group 4 siblings.

```bash
cd "$(git rev-parse --show-toplevel)"
CONDUCTOR_WORKSPACE_NAME="$CONDUCTOR_WORKSPACE_NAME" \
  ROSE_EXCLUDE_ANTHROPIC_FAMILY=1 \
  SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt \
  BENCHMARK_SKIP_WMH_BUILD=1 \
  bash scripts/run-deploy-stage agentcard-lifecycle -- \
  bash scripts/run-bench --local agent-payment-test-shop agent-payment-setup-resume agent-payment-idempotent-abandonment agent-payment-abandonment --bootstrap --max-concurrency 1 --no-dashboard
```

These four real-mode payment tasks never use the simulated World Model Harness.
The explicit opt-out prevents every fresh deploy workspace from downloading the
full trace archive and running a first-time GEPA build before the payment gate.

The bootstrap must report an AgentCard sandbox pool of at least $500. This is
test-only float provisioned through the authenticated admin session; it does not
bypass Organization MCP in the purchase path. All four tasks must pass with
their full purchase, Stripe, AgentCard card, organization transfer, attention,
and cleanup assertions. A missing lifecycle snapshot, skipped task, unreclaimed
abandonment transfer, or unrefunded Stripe capture blocks deploy. Record the
four task results and total cost in `TEST_REPORT`.

## Step 6b: Semantic tests + fix

Semantic tests exercise real user flows through Playwright/Chromium against the full local stack (backend + worker + **frontend**). They are the only gate that proves realtime broadcasts reach the UI and that the login path still works end-to-end.

**Semantic tests run on every /deploy unless the user explicitly overrides that gate.** This is independent of the smoke-benchmark change classifier: documentation-only, test-only, frontend-only, and backend-only deploys all run the complete semantic suite by default. A deploy changes production state even when the app diff is small, so the user-visible frontend contract is normally re-proven.

### Running semantic tests

With the full stack from Step 5 still running (backend, worker, **and frontend on `$SMOKE_FRONTEND_URL`**):

```bash
cd "$(git rev-parse --show-toplevel)"
SEMANTIC_WORKERS=4 BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh
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

After all Group 4 lanes pass, run the mandatory Step 5 teardown. If any lane
fails, preserve the failed agent long enough to collect diagnostics, complete
any payment lifecycle cleanup, then tear down before restarting the Test Loop.

Finalize and print the timing summary before evaluating the Phase 2 hard gate. The interval-union metrics separate true parallel overlap from untimed gaps:

```bash
bash scripts/run-deploy-stage --finish
```

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

# ║ 4s. Deploy environment + command structural tests: 100% pass ║

# ║ 4a. Back-end coverage + blackbox: threshold + all pass ║

# ║ 4b. Front-end coverage + blackbox: threshold + all pass ║

# ║ 4g. Agents coverage + blackbox: threshold + all pass ║

# ║ 4c. Credential health: all integrations authenticate ║

# ║ 4m-coverage. Mac coverage + blackbox: threshold + all pass ║

# ║ 6. Smoke benchmarks: complete Pre-Deploy group passes ║

# ║ (currently 6/6) via run-predeploy-local (default) or the ║

# ║ cloud fleet alternate — OR explicitly skipped per the ║

# ║ "When smoke can be skipped" table in Step 6 (diff must be ║

# ║ limited to safe paths; if ANY must-run path is touched, smoke ║

# ║ is required) ║

# ║ 6a. AgentCard sandbox lifecycle: 4/4 pass whenever the payment ║

# ║ lifecycle surface changed ║

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

# ║ Step 6 table — back-end/ changes ALSO require              ║

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
ESCAPED_WORKSPACE_PATH=$(printf "%s" "$PWD" | sed "s/'/''/g")
ESCAPED_BRANCH=$(printf "%s" "$(git branch --show-current)" | sed "s/'/''/g")
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "UPDATE workspaces SET pr_title_locked = '$ESCAPED_TITLE' WHERE workspace_path = '$ESCAPED_WORKSPACE_PATH' AND branch = '$ESCAPED_BRANCH'"
```

From this point on, Steps 9–13 should read the PR title from this record (rather than querying GitHub) so the workspace and the deploy flow agree on what's shipping:

```bash
ESCAPED_WORKSPACE_PATH=$(printf "%s" "$PWD" | sed "s/'/''/g")
ESCAPED_BRANCH=$(printf "%s" "$(git branch --show-current)" | sed "s/'/''/g")
PR_TITLE=$(sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "SELECT pr_title_locked FROM workspaces WHERE workspace_path = '$ESCAPED_WORKSPACE_PATH' AND branch = '$ESCAPED_BRANCH'")
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

As soon as a reviewer reaches a terminal result (clean or findings), record the
review lifecycle finish before proceeding or fixing anything:

```bash
python3 scripts/record_factory_event.py deploy stage-finish code-review
```

If findings require a new push, the restarted Test Loop records a new review
start; that retry is intentionally a separate run in `/factory-review`.

- **APPROVED** with no critical issues → proceed to Phase 3.
- **CHANGES_REQUESTED** or any comment flagging issues → fix them, push, **re-run the full Test Loop (Phase 1)**, then come back to Step 9.
- **CODE RABBIT UNAVAILABLE** (quota, spending cap, rate limit, service failure, or false-green check) → use the Claude fallback from Step 9a.
- **REVIEW SKIPPED** (e.g., "Too many files!") → first try filtering, then use the Claude fallback if filtering doesn't fit. CodeRabbit Free caps reviews at 150 files. Add safe path filters to `.coderabbit.yaml`'s `reviews.path_filters` block, push, and let the next CodeRabbit run pick up the new filter. The list below is the canonical safe-filter set — these paths are already gated by /deploy's local checks, so excluding them from CodeRabbit doesn't lose coverage:
  ```yaml
  # Tests (gated by combined Step 4 coverage-blackbox / Step 6 / Step 6b locally)
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

Immediately before merging, start the production-verification lifecycle:

```bash
python3 scripts/record_factory_event.py deploy stage-start production-verify
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

## Step 13c: AgentCard production lifecycle gate

Skip only when `$CHANGED_AGENTCARD_PAYMENT` is empty. Run after both the backend and frontend merged commits are live:

```bash
cd "$(git rev-parse --show-toplevel)/agents" && source venv/bin/activate
python benchmarks/run_benchmark.py \
  --task agent-payment-production-abandonment \
  --prod \
  --ci \
  --bootstrap
```

This production-only task reserves exactly $1.00 from the existing AgentCard organization float, captures the matching live Stripe payment, issues a live AgentCard, and deliberately leaves merchant checkout unsubmitted. The benchmark must then close the card, observe the organization transfer as `reclaimed` with `livemode=true`, refund the Stripe capture, and report no open payment attention request.

The runner performs the abandon/reclaim/refund action idempotently on success, failure, cancellation, and verifier errors before deleting the benchmark agent. Any missing cleanup snapshot or non-terminal lifecycle state fails the command. Do not declare the deploy complete until this task passes; if the process is forcibly killed, recover the printed agent ID through `/api/test-payment/lifecycle/abandon` and verify the same terminal assertions before rerunning.

After every applicable production deployment, health, semantic, release, and
AgentCard gate is green, close the production-verification lifecycle:

```bash
python3 scripts/record_factory_event.py deploy stage-finish production-verify
```

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

Record the completed lifecycle before the final response:

```bash
python3 scripts/record_factory_event.py deploy outcome completed
```

After the new branch is created, report to the user:

- PR URL
- Which services were deployed
- Any review issues that were fixed along the way
- The new branch name
