---
description: "Push current branch, obtain a CodeRabbit or Claude fallback review, merge, and wait for deploy to complete."
---

# Deploy

Push the current branch, create a PR, obtain a CodeRabbit review (or Claude Code fallback), merge, and wait for deploys to finish.

**This is a loop. Do NOT stop until the PR is merged and deploys are complete (or the user tells you to stop).**

**(pre-approved) A human PR reviewer is NOT mandatory** — never block merge waiting for a human GitHub review/approval; CodeRabbit (or the Claude fallback, or the usage-exhaustion skip) is the only review gate.

## Provider outages: report and retry every 10 minutes

When a provider outage blocks a deploy gate, promptly tell the user which
provider and gate are affected, the observed failure, the official incident
link when available, the deployment impact, and the next retry time in UTC.
Distinguish confirmed attribution from a suspected cause supported by an
incident and matching traces; a status-page incident alone does not prove causality.

Keep the deploy active and retry the affected failed check every 10 minutes.
Persist each attempt's start time and set its next retry due time to start +
600 seconds. Before each retry, recheck provider status and report the result
and next due time. Never overlap attempts: if execution or owned cleanup lasts
past the due time, join it before starting the next retry. Keep healthy checks
and independent diagnosis moving; do not rerun successful payment checks or
other successful lanes merely because an unrelated provider is unavailable.

Preserve every failed attempt, its original clocks, actual source identity,
artifacts and cleanup evidence. An outage does not waive a gate or turn a
failure into a pass. Continue this cadence until the affected gate passes, the
user stops the work, or evidence identifies a different cause requiring the
normal repair or credential/budget handling. Retain existing authorization,
financial limits and bounded review cycles; review-provider usage exhaustion
still follows Step 9a. A retryable outage alone is not a reason to end the turn
with a terminal blocked handoff or ask the user for another approval.
This outage path takes precedence over generic failure-handling directions;
gate criteria, cleanup, credential, financial and review requirements remain
mandatory.

## Canonical human-approval format

Every human approval request in this command—including prompt or
agent-behavior approval, a gate override, credential/billing/environment
escalation, a destructive action, or any other approval—must follow
`.claude/shared/approval-format.md`. Read it completely immediately before
composing the request. Its code-block presentation and its Before Behavior,
After Behavior, How, TL;DR, Evidence, Detail, and Downstream Implications sections
are mandatory and additive to the deploy-specific telemetry, file-link, and
snapshot rules below.

Before any request reaches the user, run that file's Golden-reference
adversarial review. A `GROUNDED` verdict clears the Step 0p, 0b and 0c human
gates: rerun the guard with its mandatory flag, record
`<Guard> | Pass | golden-reference review GROUNDED <approval-id> @ <sha>, reviewer <agent-id>`
in `TEST_REPORT`, list it in the PR body and continue. Only `NOT_GROUNDED` and
`HUMAN_REQUIRED` packets stop for the user.

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

## Step 0g: Start the deploy goal

Start the built-in `/goal` with this condition (fill in the branch). If you
cannot start it yourself, print `/goal <condition>` on its own line for the
user and continue.

The goal ends when its condition is met. At a defined stop it lets the turn
end and stays active for the user's reply. Only the user ends it early, with
`/goal clear`; never clear or pause it yourself.

    /deploy of <branch> is finished: the PR is merged, every applicable
    production lane is verified, and the scorecard ending in READY TO CLOSE
    is posted. Stopping earlier is allowed only when the last message is one
    of /deploy's defined stops: a prompt, agent-behavior or
    trajectory-injection approval request (Steps 0p/0b/0c) that the
    golden-reference review did not clear; a credential or
    billing escalation; a request for an explicit gate override; an approval
    for a destructive or irreversible action; or a deploy failure that cannot
    be fixed without the user.

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

Every `/deploy` publishes these timestamps to the repo, whatever its outcome.
Whenever a `/deploy` stops, whether completed, blocked on an approval, the user or
the review cap, or stopped by a failure it cannot fix, record
`deploy outcome completed` or `deploy outcome blocked` and then run:

```bash
python3 scripts/factory_ledger.py publish
```

It appends this machine's unpublished `/deploy`, `/RCA` and `/update-prompts`
stage records and factory events from `.context`, plus `/descend` ledger rows
that `main` lacks, to `main` as one data-only commit under
`agents/benchmarks/history/`. It never touches the working tree or the deploy
branch, and it retries when `main` moves. Require exit 0 before the final
response. Fly and Render do not deploy data-only commits under
`agents/benchmarks/`. A `/deploy` that died before its outcome is published by
the next `/deploy` on that machine.

## Step 0i: Isolated deploy-worktree preparation gate

Before any test or mutation, verify that a `/descend`-created deploy worktree
has its own persistent identity, local port range, credential links,
dependencies, and ready Postgres container. Primary Conductor worktrees pass
this check without extra setup:

```bash
bash scripts/prepare-deploy-worktree.sh --check
```

If an isolated worktree fails, return it to `/descend` preparation. Do not run
`scripts/setup-db.sh` with an inherited parent identity and do not borrow a
different worktree's database.

After a pause, rerun the existing full preparation for the same isolated
worktree and source, then require the check gate again. Load its recorded
identity first and preserve any original `--port-registry` selection:

```bash
source .context/deploy-worktree.env
bash scripts/prepare-deploy-worktree.sh \
  --worktree "$ROSE_DEPLOY_WORKTREE_PATH" --source "$ROSE_DEPLOY_SOURCE_WORKSPACE"
bash scripts/prepare-deploy-worktree.sh --check
```

Full preparation serializes its owner lock, reuses the exact identity and port
claim, validates credential links, and preserves its existing correctly labeled
Postgres container. It refuses foreign resources. The script has no `--resume`
option. Primary Conductor worktrees continue to use the check gate above.

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

### Whole-devbox collection and parallel-thread cross-validation

This command obeys **Whole-devbox deploy ownership** in `CLAUDE.md`. Invoking
`/deploy` in any thread makes that thread the coordinator for the entire devbox's
Rose work, or joins the existing coordinator. The invoking thread is never the
scope boundary. Before change detection or freezing gate inputs:

1. Resolve the canonical shared source checkout (or the recorded
   `ROSE_DEPLOY_SOURCE_WORKSPACE` for a prepared deploy worktree). Discover
   same-devbox Rose threads by `devboxId`, read their handoffs, and cross-validate
   active owners plus UI Main / Code Main when present using the read/message
   skills. Record unavailable discovery explicitly.
2. Inventory `git worktree list --porcelain` and `git status --short`, including
   committed, staged, unstaged and untracked non-ignored source. Integrate each
   outstanding current deliverable from parallel isolated worktrees into that
   shared source. Use owner receipts and history to distinguish deliverables
   from historical branches and disposable test copies; never merge every old
   branch blindly or silently omit known unfinished integration.
3. Keep one deploy owner; join an existing run instead of racing its Git or
   production mutations. Agree a source freeze with editors, then record the
   combined SHA/source digest, included paths, owners and blockers in the
   existing deploy-run receipt. Preserve all work and required approvals.
4. Run the normal gates on that combined snapshot. Prior subset-only green
   receipts do not cover newly included changes. Reconcile any later edits
   before merge and rerun affected gates; do not claim an older snapshot includes
   the whole devbox. Never stage secrets, ignored env files, caches, dependencies,
   raw research datasets or generated evidence as source.


**`/deploy` ALWAYS ships the ENTIRE worktree — every change present relative to `origin/main`, no exceptions.** This includes work you did not author: changes made by a concurrent agent sharing this worktree, pre-existing uncommitted edits, and any feature intermixed with yours. Do NOT stop to ask "these changes aren't mine / weren't part of my task." Do NOT try to isolate, cherry-pick, or exclude a subset onto a clean branch. The unit of deploy is the worktree, and everything in it is yours to carry through the gates and ship. The only reason to halt is a gate failure you cannot fix or a credential/billing escalation — never change ownership or scope. (Whoever ran `/deploy` is asserting the whole worktree is ready; the gates are what prove it.) **"Credential/billing escalation" NEVER includes a code-review provider being out of credits/quota** — that case is pre-authorized to proceed without asking (Step 9a, "Review-provider usage exhaustion").

If the branch is behind `origin/main`, sync first (commit the worktree, then
`git merge origin/main`). Resolve conflicts keeping every feature, re-sync deps
(`npm install` + `npx prisma generate`; `pip install -r requirements.txt`), and
re-run the gates on the merged tree — then proceed. Step 0 derives the latest
main-sync delta from merge history so shared type changes introduced by either
this merge or an earlier `/sync` remain lint seeds.

All Phase 1 commands run from the repo root. Compute changed paths from the complete active worktree: committed branch changes, staged/unstaged tracked changes, and untracked non-ignored files. This prevents pre-commit deploy checks from incorrectly treating a dirty branch as unchanged.

**Run every Phase 1 block that expands a file list — `$CHANGED_TS`, `$LINT_TS` — under `bash`, e.g. `bash -c '<block>'`.** These lists are newline-separated and rely on shell word splitting to become separate argv entries. The agent harness shell is zsh, which does NOT word-split unquoted parameter expansions, so running them directly passes the whole list as one filename and the stage fails with `No files matching the pattern were found`. Persist the computed lists to files (`/tmp/deploy-changed-ts.txt`, `/tmp/deploy-lint-ts.txt`) so each `bash -c` block can re-read them instead of relying on exported shell state, which does not persist between tool calls.

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
CHANGED_AGENT_RUNTIME=$(printf '%s\n' "$CHANGED_AGENTS" |
  bash "$(git rev-parse --show-toplevel)/scripts/classify-agent-runtime-changes.sh")
CHANGED_FRONTEND=$(echo "$CHANGED" | grep -E '^front-end/' || true)
CHANGED_MAC_APP=$(echo "$CHANGED" | grep -E '^mac-app/' || true)
CHANGED_CLOUDBENCH=$(echo "$CHANGED" | grep -E '^(scripts/(run\.sh|setup-db\.sh|run-in-new-session\.py|run-bench|run-bench-cloud|run-bench-fleet|run-predeploy-(cloud|local)|create-worktree-patch\.sh|cloudbench-|lib/cloudbench-env\.sh|tests/cloudbench-)|agents/benchmarks/(cloud_batch_cleanup_test|cloudbench_(dependency_sync|recovery_review)_test|run_benchmark|wall_clock_backstop_test)\.py)' || true)
CHANGED_RUNTIME_SURFACE=$([ -n "$CHANGED_BACKEND$CHANGED_AGENTS" ] && echo "yes" || echo "")
# Append-only benchmark history ledgers (agents/benchmarks/history/*.jsonl) are
# data, not payment lifecycle code; a main sync carries other deploys' rows.
CHANGED_AGENTCARD_PAYMENT=$(echo "$CHANGED" | grep -v '^agents/benchmarks/history/' | grep -E '^(back-end/(scripts/setup-benchmark-payment\.ts|src/domains/(agentcard|purchases|test-payment)/|src/providers/(agentcard/|card-provider/|purchaseCleanup\.ts|purchase-wallet-funding|wallet-funding\.ts))|agents/(benchmarks/|domains/request_payment_card/|tools/request_payment_card\.py)|front-end/src/features/test-payment/|scripts/(run\.sh|run-agentcard-lifecycle-task\.sh))' || true)

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
    BACKEND_UNIT_WORKERS=3
    AGENTS_COVERAGE_WORKERS=3
    FRONTEND_COVERAGE_WORKERS=2
    MAC_COVERAGE_WORKERS=1
  elif [ -n "$CHANGED_FRONTEND" ]; then
    BACKEND_UNIT_WORKERS=3
    AGENTS_COVERAGE_WORKERS=4
    FRONTEND_COVERAGE_WORKERS=3
  elif [ -n "$CHANGED_MAC_APP" ]; then
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

**MANDATORY for EVERY human-approval request in this deploy (Step 0p, Step 0b, Step 0c, and any other escalation): link the file(s) under review.** Whenever you stop for human approval, present each affected item as a clickable `repo-relative/path:line` reference — one per file/hunk — so the human can open and read the exact code before approving. Pasting a snippet is not enough on its own; the link is required. An approval request without file:line links is incomplete — do not ask for approval until you have listed the precise files + line ranges to review.

**For prompt / LLM-visible text (Step 0p): also paste the exact diff inline.** A `path:line` link is required but not sufficient. The approval message itself must show the precise unified diff or before/after text being approved (every added/removed line). Do not ask the human to open the file to learn what changed — that is an incomplete prompt approval under `.claude/shared/approval-format.md`.

**What "prompt modification" means — LLM-visible text, not file membership.** The rule reviews changes to what an LLM actually reads: prompt/instruction text baked in at compile time (system prompts, tool descriptions, skill/command instructions, tasks.json `prompt`/`description` fields, template files) AND text assembled at runtime (string-building logic, template interpolation, context-chunk selection, truncation — anything that changes the bytes an LLM ultimately sees). The guard script flags candidate FILES, which over-approximates: a validation helper, UI accessibility tweak, or state-handling fix inside a flagged file is NOT a prompt modification. When the guard fires:

1. Examine every flagged hunk and classify it: does it change (or change the construction of) text an LLM ever sees — at compile time or runtime?
2. If NO hunk changes LLM-visible text: state that determination in the deploy log (per file, one line on why it is code-behavior only), then pass the guard with the mandatory flag WITHOUT waiting for human approval. Record `Prompt Human Approval Guard | Pass | flagged files are code-behavior only (no LLM-visible text changed): <files>` in `TEST_REPORT`.
3. If ANY hunk changes LLM-visible text — or you are unsure (runtime string construction counts) — run the golden-reference review; unless it returns `GROUNDED`, stop and request human approval for those hunks, **each presented as a clickable `path:line` link** (per the mandatory file-link rule above). Immediately before sending the request, run `python3 scripts/record_factory_event.py deploy approval-request prompt-approval`. When mixed, list which hunks need review (with links) and which are code-behavior-only so the human reviews only what matters.

**Operational gate maintenance is pre-authorized and MUST NOT block for human approval.** Changes limited to `.claude/commands/deploy.md` instructions that detect changed paths, select or invoke tests, record verification evidence, or tighten CI/deploy gates do not alter product or agent prompts. Classify those hunks as operational code behavior, rerun the guard with the mandatory flag immediately, and continue. Never stop an active implementation, RCA, benchmark, or deploy goal to ask permission for test-gate wiring.

Run the guard without the approval flag first:

```bash
bash scripts/run-deploy-stage prompt-approval -- bash scripts/check-prompt-human-approval.sh
```

If it passes, record `Prompt Human Approval Guard | Pass | no prompt edits detected` in `TEST_REPORT`.

If it fails, apply the classification above. For hunks that change LLM-visible text, unless the golden-reference review returns `GROUNDED`, stop and ask the human to review them, **linking each one as a clickable `path:line` reference** so they can open the file. Do not infer approval from silence, prior discussion, or the fact that the branch exists.

Human approval is scoped only to the prompt diff that exists when approval is requested. If LLM-visible text in any prompt, instruction, command, skill, or prompt-related file changes later — including changes made to fix tests or smoke benchmarks — re-run the guard without the approval flag, run a new golden-reference review of the new prompt diff and, unless it returns `GROUNDED`, show that diff and wait for fresh explicit approval before continuing. Later code-behavior-only changes to flagged files follow rule 2 above (classify, log, proceed).

After the human responds, first run `python3 scripts/record_factory_event.py deploy approval-decision approved` (or `rejected`). A rejection remains blocked. After an approval, rerun the guard with the mandatory flag:

```bash
bash scripts/run-deploy-stage prompt-approval -- bash scripts/check-prompt-human-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) may satisfy the guard. Do not pass it until explicit human approval has been retrieved in this deploy flow for the current prompt diff, or a `GROUNDED` golden-reference review covers that exact diff. Record `Prompt Human Approval Guard | Pass | human approval retrieved for prompt edits` (or the review line from Canonical human-approval format) in `TEST_REPORT`.

## Step 0b: Agent recovery / terminal-behavior human-approval guard (no skip — always runs)

The prompt guard (Step 0p) only catches changes to **LLM-visible text**. It cannot catch a change to **agent control-flow semantics** — flipping a recoverable failure into a terminal one, deleting a recovery fall-through, or inverting a recovery-invariant test. Those are as consequential as a prompt change but invisible to a text-only gate, and **an automated test cannot validate that the new behavior is the correct product decision** (the author just updates the test to match — all green). Regression precedent: commit `500715a5f` turned every single-planned-task DAG failure into a terminal agent FAILED instead of continuing iteration, and shipped green because its blackbox test was rewritten to bless the new behavior.

This guard scans the narrow agent control-flow layer (`agents/loop/run_agent.py`, `agents/loop/dag_executor.py`, `agents/workflows/agent_workflow.py`) and its behavior tests (`agents/tests/blackbox/{workflow,dag_executor,workflow_determinism}.blackbox.py`) for **hunks that change recovery vs. terminal semantics** — status/reason literals (`error`/`failed`/`aborted`/`max_iterations`/`needs_llm`/`completed`/`paused`), `_handle_incomplete`/`_mark_failed`/`_mark_complete`/`run_agent(` fall-through, `continue_as_new`, or a removed/replaced recovery-invariant test assertion (`run_agent_calls`, "must not run", `recovers_via`, result-status dicts). Purely additive tests do not require approval because they cannot change runtime behavior or rewrite an existing expectation. Comment- and logging-only edits are also stripped.

Run the guard without the approval flag first:

```bash
bash scripts/run-deploy-stage agent-behavior-approval -- bash scripts/check-agent-behavior-approval.sh
```

If it passes (no watched-file change, or no recovery/terminal-semantics hunk), record `Agent Behavior Approval Guard | Pass | no agent-behavior changes detected` in `TEST_REPORT`.

If it fails, examine every flagged hunk. Unlike Step 0p there is no "code-behavior only" bypass — a flagged hunk **is** an agent-behavior change by construction. Run the golden-reference review; unless it returns `GROUNDED`, stop and request explicit human approval for it — **presenting each hunk as a clickable `path:line` link** (per the mandatory file-link rule in Step 0p) — and state, in one line, how it changes when the agent gives up vs. keeps iterating. Immediately before sending the request, run `python3 scripts/record_factory_event.py deploy approval-request agent-behavior-approval`. Approval is snapshot-scoped exactly like the prompt gate: if later fixes add or change recovery/terminal hunks, re-run without the flag and request fresh approval. After the human responds, first run `python3 scripts/record_factory_event.py deploy approval-decision approved` (or `rejected`); a rejection remains blocked. After approval, rerun with the mandatory flag:

```bash
bash scripts/run-deploy-stage agent-behavior-approval -- bash scripts/check-agent-behavior-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) satisfies the guard; pass it only after human approval or a `GROUNDED` golden-reference review of the current hunks. Record `Agent Behavior Approval Guard | Pass | human approval retrieved for agent-behavior edits` (or the review line) in `TEST_REPORT`.

## Step 0c: LLM trajectory-injection human-approval guard (no skip — always runs)

The prompt guard (Step 0p) catches **compile-time prompt strings** and some runtime prompt construction. Step 0b catches **recovery vs. terminal control-flow** flips. Neither catches harness code that **injects synthetic user/tool turns or mid-run context into the planning LLM's message history** without touching a `*_PROMPT` constant — e.g. provider-exit fabricated tool failures fed back via `browser_turn_messages`, browser-supervisor recovery nudges, OTP/handoff resume user messages, auth-assistance block messages, or classifier recovery constraints wired through `build_challenge_classifier_messages`. Those edits are as consequential as a prompt change but often evade the text-only gate because the strings live inside control flow.

This guard scans the narrow harness layers that own runtime trajectory injection (`agents/domains/spawn_browser_agent_v3/{handler,service}.py`, `challenge_llm_classifier.py`, `back-end/src/providers/browser/challengeLlmClassifier.ts`, `agents/providers/rose/browser_use.py`, `agents/loop/run_agent.py`, `agents/domains/spawn_claude_code_agent/service.py`) for **hunks that add, remove, or rewrite synthetic trajectory the planner reads at runtime** — `_append_browser_turn_messages`, `browser_turn_messages.append/extend`, `_feed_provider_exit_detected_back`, supervisor/OTP/handoff injection helpers, `build_challenge_classifier_messages` recovery lines, `dynamic_system_context` rebuilds, and harness-authored trajectory strings. Comment-only edits are stripped.

Run the guard without the approval flag first:

```bash
bash scripts/run-deploy-stage llm-trajectory-injection-approval -- bash scripts/check-llm-trajectory-injection-approval.sh
```

If it passes (no watched-file change, or no trajectory-injection hunk), record `LLM Trajectory Injection Approval Guard | Pass | no trajectory-injection changes detected` in `TEST_REPORT`.

If it fails, examine every flagged hunk. Unlike Step 0p there is no "code-behavior only" bypass — a flagged hunk **is** a runtime trajectory-injection change by construction. Run the golden-reference review; unless it returns `GROUNDED`, stop and request explicit human approval for it — **presenting each hunk as a clickable `path:line` link** (per the mandatory file-link rule in Step 0p) — and state, in one line, what synthetic context the planner will now see (or stop seeing) at runtime. Immediately before sending the request, run `python3 scripts/record_factory_event.py deploy approval-request llm-trajectory-injection-approval`. Approval is snapshot-scoped exactly like the prompt gate: if later fixes add or change trajectory-injection hunks, re-run without the flag and request fresh approval. After the human responds, first run `python3 scripts/record_factory_event.py deploy approval-decision approved` (or `rejected`); a rejection remains blocked. After approval, rerun with the mandatory flag:

```bash
bash scripts/run-deploy-stage llm-trajectory-injection-approval -- bash scripts/check-llm-trajectory-injection-approval.sh mandatory-human-approval-retrieved=true
```

Only this exact flag (or `--mandatory-human-approval-retrieved=true`) satisfies the guard; pass it only after human approval or a `GROUNDED` golden-reference review of the current hunks. Record `LLM Trajectory Injection Approval Guard | Pass | human approval retrieved for trajectory-injection edits` (or the review line) in `TEST_REPORT`.

**Execution model for Steps 1–4a (run in this order):**

1. **Prompt approval gate** (read-only, always first): Step 0p. If prompt edits are detected, stop until a human approves them (or the golden-reference review returns `GROUNDED`), then rerun Step 0p with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change prompt/instruction files, return to Step 0p without the flag and request fresh approval for those additional prompt changes.
   1b. **Agent-behavior approval gate** (read-only, runs alongside Step 0p): Step 0b. If recovery/terminal-semantics hunks are detected, stop until a human approves them (or the golden-reference review returns `GROUNDED`), then rerun Step 0b with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change agent-behavior hunks, return to Step 0b without the flag and request fresh approval.
   1c. **LLM trajectory-injection approval gate** (read-only, runs alongside Steps 0p/0b): Step 0c. If runtime trajectory-injection hunks are detected, stop until a human approves them (or the golden-reference review returns `GROUNDED`), then rerun Step 0c with `mandatory-human-approval-retrieved=true`. If later fixes introduce or change trajectory-injection hunks, return to Step 0c without the flag and request fresh approval.
2. **Sequential mutators** (they write files — cannot parallelize): Step 1 (`prettier --write`) → Step 2a (`eslint --fix`) → Step 1m (`mac-app format + lint --fix`, skip if `CHANGED_MAC_APP` is empty). Commit any resulting changes once.
3. **Parallel Group 3** (all read-only after the mutators; start every applicable
   lane in one assistant message with separate Bash tool calls, using the worker
   budgets computed above, except for the Step 4cb ordering rule below). Every repository
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
   - Step 4: structural tests (no skip)
   - Step 4s: deploy environment + command structural tests (no skip)
   - Step 4m-lint: mac-app format:check + lint + type-check (skip if `CHANGED_MAC_APP` is empty)
   - Step 4cb: cloud benchmark controller regressions (skip if `CHANGED_CLOUDBENCH` is empty). If
     `CHANGED_AGENTS` is also non-empty, defer this lane until Step 4g exits; the agents
     `benchmark` domain and these controller suites share local controller locks and fixture
     state. This deferred lane remains inside the `runtime-blackbox` boundary.

   **Coverage + Runtime blackbox (one execution, reported in both rows):**
   - Step 4a: back-end blackbox + unit tests under coverage (skip if
     `CHANGED_BACKEND` is empty)
   - Step 4b: front-end blackbox + structural tests under coverage (skip if
     `CHANGED_FRONTEND` is empty)
   - Step 4g: agents blackbox + DEMO cache + unit tests under coverage (skip if
     `CHANGED_AGENTS` is empty)
   - Step 4m-coverage: mac-app blackbox tests under coverage (skip if
     `CHANGED_MAC_APP` is empty)

   After those parallel branches finish, Step 4p launches Step 4c's focused credential
   health probe and Step 4h's focused live Amplitude probe concurrently once each. Coverage
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

If `$CHANGED_TS` is non-empty, format them.

**Write the file list to a file and feed it via `xargs` — do not interpolate
`$CHANGED_TS` directly.** These newline-separated lists rely on word splitting,
which `bash` does and **`zsh` does not**. Under zsh (the default interactive
shell on this machine) a bare `$CHANGED_TS` expands to ONE argument and the
command dies with `ENAMETOOLONG: name too long` naming a bogus multi-line path.

```bash
printf '%s\n' "$CHANGED_TS" | grep -v '^$' > .context/deploy-changed-ts.txt
cd back-end && bash ../scripts/run-deploy-stage prettier -- \
  bash -c 'xargs npx prettier --write < ../.context/deploy-changed-ts.txt'
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

Feed `$LINT_TS` through a file + `xargs` for the same zsh word-splitting reason
described in Step 1 — never interpolate the list directly.

```bash
printf '%s\n' "$LINT_TS" | grep -v '^$' > .context/deploy-lint-ts.txt
```

**Step 2a (mutator — runs before the parallel verifier batch):**

```bash
cd back-end && bash ../scripts/run-deploy-stage eslint-fix -- \
  bash -c 'xargs node scripts/lint-affected.mjs --fix < ../.context/deploy-lint-ts.txt'
```

**Step 2b (verifier — runs in parallel with Steps 3, 4, 4a):**

```bash
cd back-end && bash ../scripts/run-deploy-stage eslint --reuse-passed -- \
  bash -c 'xargs node scripts/lint-affected.mjs < ../.context/deploy-lint-ts.txt'
```

If there are remaining errors, fix them manually. Loop until the affected-file lint reports 0 errors.

**CRITICAL: You must reach 0 errors across every affected file. "Pre-existing" or "this error was already on main" is NOT an excuse to skip it.** This includes `no-console`, `no-explicit-any`, `strict-boolean-expressions`, `max-lines`, and any other rule. Fix them all.

If any files were modified by this step, stage and commit them (can combine with Step 1's commit if both ran together).

## Step 3: TypeScript type check

```bash
cd back-end && bash ../scripts/run-deploy-stage typescript --reuse-passed -- npx tsc --noEmit
```

Catches type errors that ESLint misses (wrong argument types, missing properties, bad generics). Fix any errors before proceeding — pre-existing type errors in touched files are your responsibility.

## Step 4: Structural tests + fix (no skip)

```bash
cd back-end && bash ../scripts/run-deploy-stage backend-structural --reuse-passed -- npm run test:structural
```

`npm run test:structural` runs every back-end structural suite listed in
`back-end/package.json`: `layer-deps` (import direction, cross-domain
isolation, provider/util boundaries, domain completeness, Prisma/Express
encapsulation, circular imports) plus migration drift, the Claude Code
ws-server prompt/env contract, the RCA archive schema, and the rest. It runs on
every deploy because several suites guard non-TS inputs (migrations, the E2B
template, `docs/rca/`). `scripts/tests/semantic-deploy-gate.test.sh` fails if a
`*.test.ts` file in `back-end/src/tests/structural/` is missing from that list.

If any invariant fails, fix the violation. The test output includes remediation guidance (e.g., "Move the needed logic to service.ts or extract to a provider.").

## Step 4s: Deploy environment + command structural tests (no skip)

The concurrent runner executes exactly these independent suites, without changing
their assertions or test counts:

`bash scripts/tests/workspace-env.test.sh`,
`python3 scripts/tests/temporal-namespace-isolation.test.py`,
`python3 scripts/tests/swap-harness.test.py`,
`bash scripts/tests/kill-services.test.sh`,
`bash scripts/tests/deploy-worktree-preflight.test.sh`,
`bash scripts/tests/seed-cache-decision.test.sh`,
`bash scripts/tests/canonical-seed-whatsapp-content.test.sh`,
`bash scripts/tests/seed-memory-ratchet.test.sh`,
`bash scripts/tests/semantic-deploy-gate.test.sh`,
`bash scripts/tests/check-prompt-human-approval.test.sh`,
`bash scripts/tests/check-agent-behavior-approval.test.sh`,
`bash scripts/tests/check-llm-trajectory-injection-approval.test.sh`,
`bash scripts/tests/approval-format.test.sh`,
`bash scripts/tests/durable-evidence-links.test.sh`,
`bash scripts/tests/publish_evidence_links_browser_validation.test.sh`,
`bash scripts/tests/publish_evidence_links_composite.test.sh`,
`bash scripts/tests/workflow-deployment-migration.test.sh`,
`bash scripts/tests/cooperative-cutover-monitor.test.sh`,
`bash scripts/tests/agents-structural.test.sh`,
`bash scripts/tests/deploy-agent-clone-recovery.test.sh`,
`bash scripts/tests/agent-surface-hash.test.sh`,
`bash scripts/tests/benchmark-sms-transport-mock.test.sh`,
`bash scripts/tests/descend-command.test.sh`,
`python3 scripts/tests/benchmark-live-results.test.py`,
`python3 scripts/tests/jev-progress-core.test.py`,
`python3 scripts/tests/benchmark-history-latest-only.test.py`,
`python3 scripts/tests/cloudbench-full-selection.test.py`,
`python3 -m unittest discover -s scripts/live_display -p test_*.py`,
`python3 scripts/tests/cloudbench-provider-capacity.test.py`,
`bash scripts/tests/campaign-hub-grouping.test.sh`,
`bash scripts/tests/cloudbench-fetch-ref.test.sh`,
`python3 scripts/tests/verify-successful-llm-queries.test.py`,
`python3 scripts/tests/cloudbench-exact-session-multi-root.test.py`,
`python3 scripts/tests/cloudbench-forensic-quiesced.test.py`,
`python3 scripts/tests/cloudbench-controller-linux.test.py`,
`python3 scripts/tests/factory-review.test.py`,
`python3 scripts/biz_review.py self-test`,
`python3 scripts/tests/cloudbench-rejected-start-recovery.test.py`,
`python3 scripts/tests/cloudbench-prestack-recovery.test.py`,
`python3 scripts/tests/cloudbench-bootstrap-recovery.test.py`,
`python3 scripts/tests/cloudbench-staged-boot.test.py`,
`python3 scripts/tests/cloudbench-prelaunch-cancel.test.py`,
`python3 scripts/tests/cloudbench-controller-gate-flyctl-bounds.test.py`,
`python3 scripts/tests/cloudbench-static-service-observation.test.py`,
`python3 scripts/tests/cloudbench-scorecard.test.py`,
`python3 scripts/tests/original600-portable-operator.test.py`,
`python3 scripts/tests/cloudbench-explicit-idle-admission.test.py`,
`python3 scripts/tests/cloudbench-fixed-native-worker.test.py`,
`python3 scripts/tests/cloudbench-protected-resources.test.py`,
`python3 scripts/tests/cloudbench-pool-run-token.test.py`,
`python3 scripts/tests/cloudbench-live-primary-return.test.py`,
`python3 scripts/tests/cloudbench-primary-exact-shape-reuse.test.py`,
`python3 scripts/tests/cloudbench-maintenance-env.test.py`,
`python3 scripts/tests/cloudbench-resume-controller-export.test.py`,
`python3 scripts/tests/cloudbench-controller-orphan-drain.test.py`,
`python3 scripts/tests/wait-for-code-review.test.py`,
`python3 scripts/tests/read-graphide-review.test.py`,
`python3 scripts/tests/deploy-review-cycle.test.py`,
`bash scripts/tests/run-deploy-stage.test.sh`,
`python3 scripts/tests/run-deploy-structural-gates.test.py`,
`python3 scripts/tests/deploy-live-probes.test.py`,
`bash scripts/tests/run-process-cleanup.test.sh`,
`bash scripts/tests/run-isolated-cloud-kill.test.sh`,
`bash scripts/tests/run-seed-exit-code.test.sh`,
`bash scripts/tests/run-public-tunnel-routing.test.sh`,
`bash scripts/tests/setup-db-concurrency.test.sh`,
`bash scripts/tests/run-port-collision.test.sh`,
`bash scripts/tests/run-cloud-benchmark-workers.test.sh`,
`bash scripts/tests/blackbox-archive-env.test.sh`, and
`python3 agents/tests/structural/structural_test_registration.py`.

This list is deliberately explicit, not a registry pointer: several of these
suites assert that their own command still appears here, which is how a gate
cannot be silently dropped from the deploy path. `run-deploy-structural-gates.test.py`
asserts this list and the `GATES` registry match exactly in both directions, so
adding a gate without documenting it here fails the build.

The descend gate owns its behavioral fixtures. The semantic deploy gate
verifies its registration and documented command without recursively executing
it, so it runs once in the complete registry.

The compact benchmark gates above run on every deploy, including deploys
without cloud-runner changes. They exercise the canonical CLI dispatch (including
one 50-task dispatch and production-only routing), completed LIVE-query evidence,
exact composite-root cleanup, and quiesced resource retirement offline. Larger
paid fleet campaigns remain explicit human-requested validation; they are not
added to this automatic gate.

The same compact `benchmark-live-results.test.py` gate also covers cold-image
CLI context/provenance, joined image installers and retained artifacts, actual
Vite/SWC/Rollup/esbuild native readiness, isolated dependency overlay/copy fallback
and Prisma freshness, immutable read-only cache receipts, explicit DEMO replay
admission, task-only read-only guards, genuine replay hits, ordinary flag-off
behavior and pooled/worker handoff. It calls the owning controls through
the supported scripts; it adds no paid fleet stage. Explicit cold/cached startup
experiments use `/benchmark` and its Operations Runbook commands, without replacing deploy
smoke outcomes. The mass-demo `-k 50 --concurrency 50 --strict-barrier` diagnostic
means 50 controllers and 2,500 first-level children; task replay has zero LIVE proof
credit and its unchanged declared judges may make provider calls. Ordinary
source-only deploy benchmarks reuse the pinned dependency image and exact source
checkout; REAL runs use fresh volumes by default.
Cold `image-build` defaults to Fly-integrated Depot (app scope, zstd level 3,
`linux/amd64`); explicit `--builder native` remains available for diagnostics.
The independent `807edee9f` no-cache build/push completed in 493.6 seconds in one attempt,
excluding activation/fleet startup. Retain its receipt, activate the exact image
and verify guest digest/runtime consumption before the benchmark cohort.
Image publication automatically caches its checksum-verified pinned Fly client
in the Git common directory; native uses child-only classic Docker over HTTPS
(`DOCKER_BUILDKIT=0`, `--wg=false`). Shared Fly/PATH and runtime remain unchanged.
The 31.6-second tiny CLI control is not full cold-image timing. Strict repeated
campaigns also have compact cohort readiness, healthy-survivor continuation,
exact release-membership and catastrophic abort/inverse controls here, with the
existing startup budget and normal owned cleanup. Controller count alone
does not prove execution overlap; ordinary non-strict scheduling is unchanged.

For an explicit cold-image measurement, activate the exact image from its build receipt before the fleet:

```bash
scripts/run-bench image-build --builder depot --no-cache --build-context <committed-checkout> --out-dir .context/image-build
benchmark_image_ref=$(python3 -c 'import json; print(json.load(open(".context/image-build/cloudbench-image-build.json"))["image_ref"])')
scripts/run-bench image-activate "$benchmark_image_ref" --ref "$(git rev-parse HEAD)" --out-dir .context/image-activation
```

`image-activate` uses the existing app environment lock and owned warm-source setup, activates the published image on the donor and this workspace's pool, synchronizes the requested Git ref, and parks the donor. It sets the existing prebuilt-image selection internally, so it does not build again. Confirm guest image digests in the ensuing fleet's native inventory. Source-only branch runs normally reuse verified dependencies and need no image build or activation.

Repeated concurrent cloud campaigns share one parent-owned Machines/Volumes inventory feed. Borrowers retain the same keyed generation and never stop the publisher; capacity admission and exact resource teardown checks stay native. A standalone fleet and production-only campaigns keep their existing paths.

The existing recorded mass-demo diagnostic, when explicitly requested:

```bash
CLOUDBENCH_APP_MACHINE_CEILING=138 \
BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=300 \
  scripts/run-bench test-mass-agent-run-0 --demo-cache \
  -k 50 --concurrency 50 --strict-barrier --autoscale-max 2 --timeout 300
```

For this explicitly requested 50-copy cached stress run, use the command-scoped
Machine ceiling of 138 and `--autoscale-max 2`: the current 36 existing app
Machines plus 50 primaries, up to 50 optional autoscaler workers and two transient
slots. Inspect native app inventory and headroom again before a future run;
ordinary ceiling 56 cannot hold this current cohort, and ceiling 88 leaves only
two worker slots. This profile creates no idle resources and changes no default
ceiling, shared-CPU governor or production headroom. `--strict-barrier` keeps all
50 copies in one ready cohort; controller occupancy does not prove execution overlap.

Poll the printed campaign `summary.json` with `python3 -m json.tool` every 30
seconds, then follow each job log's exact printed fleet-monitor handle through
controller exit and owned teardown. The campaign directory itself is not a
fleet-monitor handle; task PASS/FAIL is available before cleanup finishes.

During deploy benchmarks, follow the "Monitor every cloud launch"
instructions in the Operations Runbook in `agents/benchmarks/README.md` and
the exact metrics command in the printed controller log.
Poll every 30 seconds, check the printed controller exit marker on every poll,
and observe through owned-resource release. Early task PASS/FAIL and stale cards
are distinct from controller exit and cleanup. The existing live-results gate
also runs the compact monitor controls; no additional live verification is added.

The structural runner admits eight suites concurrently by default and runs the
complete registry. Use `--max-workers N` to choose a host-appropriate limit;
this changes test scheduling only, not benchmark fleet width or task deadlines.
Activate `agents/venv` and keep its `bin` before Homebrew in `PATH`, since the
registered Python children inherit that interpreter selection.
Fixture process-start and cleanup observations allow sixty seconds of host
breathing room while retaining terminal-state and exact-owner assertions.

```bash
bash scripts/run-deploy-stage deploy-command-structural --reuse-passed -- \
  python3 scripts/run-deploy-structural-gates.py
bash scripts/run-deploy-stage seed-cache-decision --reuse-passed -- \
  bash scripts/tests/seed-cache-decision.test.sh
bash scripts/run-deploy-stage canonical-seed-whatsapp-content --reuse-passed -- \
  bash scripts/tests/canonical-seed-whatsapp-content.test.sh
```

These tests execute the workspace identity boundary with a stale Conductor display name and verify that the DB container, DB volume, and Temporal queue all use the normalized worktree identity. `setup-db-concurrency.test.sh` pins that two concurrent `scripts/setup-db.sh` invocations for one workspace serialize their destructive reset/push/seed instead of wiping each other's in-flight prod sync. They also enforce that `/deploy` keeps this gate and the bounded production workflow migration wired into every run. `check-agent-behavior-approval.test.sh` pins the Step 0b guard's detection logic (it fires on recovery/terminal-semantics hunks, passes on comment/logging noise and unwatched files). `check-llm-trajectory-injection-approval.test.sh` pins the Step 0c guard's detection logic (it fires on runtime trajectory-injection hunks in the browser/main-agent harness layers, passes on comment-only noise and unwatched files).
The separately logged seed-cache decision suite preserves the atomic shared-dump
and Prisma-freshness contract introduced before the concurrent structural
runner. `canonical-seed-whatsapp-content.test.sh` pins that the whatsapp-v2
canonical base restores reviewed WhatsApp rows (and that publish refuses a
cold-sync substitute).

## Step 4a: Back-end coverage + blackbox (skip if no back-end/ changes)

```bash
cd back-end && bash ../scripts/run-deploy-stage backend-coverage-blackbox --reuse-passed -- \
  env BLACKBOX_TEST_CONCURRENCY="$BACKEND_BLACKBOX_WORKERS" \
      CONTRACT_TEST_CONCURRENCY="$BACKEND_BLACKBOX_WORKERS" \
      BACKEND_UNIT_CONCURRENCY="$BACKEND_UNIT_WORKERS" \
      npm run test:coverage
```

This one command runs all 91 deterministic back-end blackbox domains plus unit
tests under V8 coverage. It must both pass every test and meet
`back-end/.c8rc.json`; the real provider credential probe runs once in Step 4c.
After coverage passes it runs `scripts/tests/blackbox-backend-teardown.test.sh`,
which drives the isolated-backend runner through a normal exit and a SIGTERM and
fails if either leaves its backend or port lock behind. It runs here, after the
coverage server stops, rather than in Step 4s because it boots a real backend
and regenerates the Prisma client.

## Step 4b: Front-end coverage + blackbox (skip if no front-end/ changes)

```bash
cd front-end && bash ../scripts/run-deploy-stage frontend-coverage-blackbox --reuse-passed -- \
  npm run test:coverage -- --maxWorkers="$FRONTEND_COVERAGE_WORKERS"
```

This one command runs every front-end blackbox and structural Vitest under
coverage. Every test must pass and coverage must meet `front-end/vitest.config.ts`.
Never loosen the threshold or rerun the same blackbox suite separately.

## Step 4g: Agents coverage + blackbox (skip if no agents/ changes)

```bash
cd agents && bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- \
  env AGENTS_COVERAGE_CONCURRENCY="$AGENTS_COVERAGE_WORKERS" \
      bash scripts/run-coverage.sh
```

This one command runs every agents blackbox plus DEMO cache and unit tests under
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
cd mac-app && bash ../scripts/run-deploy-stage mac-static --reuse-passed -- bash -c 'npm run format:check && npm run lint && npm run type-check'
```

If any check fails, fix and re-run. `npm run lint` applies both base rules and the type-aware strict overlay defined by `STRICT_DOMAIN_FILES` in `mac-app/eslint.config.mjs` (max-lines, max-lines-per-function, no-floating-promises, strict-boolean-expressions, etc.).

## Step 4m-coverage: Mac-app coverage + blackbox (skip if `$CHANGED_MAC_APP` is empty)

```bash
cd mac-app && bash ../scripts/run-deploy-stage mac-coverage-blackbox --reuse-passed -- \
  npm run test:coverage -- --maxWorkers="$MAC_COVERAGE_WORKERS"
```

This one command runs the complete mac-app Vitest/MSW/jsdom blackbox suite under
coverage. Every domain must pass and coverage must meet `mac-app/vitest.config.ts`.
Never loosen the threshold or launch `scripts/run-blackbox-tests.sh` afterward.

If the failure is renderer-only (jsdom + React), check `mac-app/tests/blackbox/test-wrapper.tsx` and the relevant MSW handlers in `mac-app/tests/blackbox/msw/handlers.ts`. If it's main-process (Node + Electron stubs), check `mac-app/tests/blackbox/electron-stubs.ts` and `mac-app/tests/blackbox/fetch-capture.ts`.

## Step 4cb: Cloud benchmark controller regressions (skip if `$CHANGED_CLOUDBENCH` is empty)

Cloud benchmark scripts own Fly lifecycle, local proxy ports, synchronized barrier release, and durable machine cleanup. When that surface changes, run the fast functional regression plus the focused lifecycle cases before any paid cloud run.

**Run this gate on Linux, not on the Mac.** Several of these suites read `/proc` and
depend on native Linux process semantics; on macOS three of them fail identically on
`main` and on every branch, which is not a signal about the branch. The gate's home is
a throwaway machine in the benchmark Fly app, built from the fleet's warm image, that
fetches the pushed HEAD and runs the suites below:

```bash
bash scripts/run-deploy-stage cloudbench-controller -- bash scripts/run-cloudbench-controller-gate
```

It prints `GATE_STEP <suite> exit=N` per suite and exits with the overall result; the
machine log lands under `.context/cloudbench-gate-<machine>.log` and every failed suite's
complete output is copied to `.context/cloudbench-gate-<machine>-step-<n>.log` before the
machine is destroyed. Run one suite with `-- "<command>"`. To
check whether a failure is pre-existing, run the same command with
`CLOUDBENCH_GATE_REF=$(git rev-parse origin/main)`. Only run the commands below directly on
a Linux host; a macOS failure of the `/proc`-dependent suites does not block the deploy and
does not need a human override, but the Linux gate must pass. These are the suites it runs:

```bash
bash scripts/tests/cloudbench-env.test.sh
bash scripts/tests/cloudbench-acceptance-autoscale.test.sh
# Driver ownership reads Linux /proc; Mac dispatches the same unchanged control
# through the offline exact-owner Linux image and verifies retirement.
python3 scripts/tests/run-cloudbench-controller-linux.py --fixture status-service-shutdown
bash scripts/tests/fleet-infra-canary.test.sh
bash scripts/tests/fleet-infra-stability-proof.test.sh
python3 scripts/tests/cloudbench-exact-session-rootless-sms.test.py
# Linux Python3.11.9/Node22.13.0; Mac dispatches this same suite to an offline container.
# It reuses the recipe-fingerprinted local image, building the small committed
# scripts/tests/cloudbench-controller-linux.Dockerfile once if absent. An existing
# verified local image may be selected with CLOUDBENCH_CONTROLLER_TEST_IMAGE.
bash scripts/tests/cloudbench-multi-workstream.test.sh
python3 scripts/tests/cloudbench-controller-linux.test.py
bash scripts/tests/cloudbench-github-token.test.sh
bash scripts/tests/seed-dump-toolchain.test.sh
agents/venv/bin/python -m pytest -q agents/benchmarks/wall_clock_backstop_test.py
agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py \
  agents/benchmarks/cloudbench_worker_snapshot_test.py \
  agents/benchmarks/cloudbench_recovery_review_test.py \
  agents/benchmarks/cloudbench_codex_auth_test.py \
  agents/benchmarks/cloud_batch_cleanup_test.py \
  -k 'fly_with_timeout or test_clone_retries_transient_volume_not_found or test_clone_gives_up_after_max_attempts or test_clone_times_out_and_retries_a_hung_clone or clone_creation_cannot_start_copied_primary or cloudbench_codex_auth or autoscaler_runtime_handoff or prisma_client or local_sync_and_stack_wire_prisma_freshness or cloud_patch_includes_tracked_and_untracked_changes or cloud_patch_detection_and_payload_include_staged_only_changes or worktree_patch_ignores_append_only_history_ledgers or patch_delivery_clears_stale_base64_configuration or shared_patch_digest_is_pinned_and_verified or declared_patch_payload_cannot_be_missing_or_empty or empty_local_patch_cleanup_is_nounset_safe or central_hub_runs_in_own_session_after_launcher_exit or boot_launch_delivers_the_exact_worktree_patch_to_every_guest or boot_launch_runs_the_current_driver_before_applying_the_patch or boot_payload or boot_launch_compresses_complete_payload or autoscaled_worker_failure_publishes_durable_failure_marker or data_plane_proxies_retry_machine_dns_and_restart_if_lost or status_polled_over_data_plane_proxy_not_ssh or cloud_runner_avoids_live_run_port_collisions or fleet_barrier_reads_the_authoritative_rotated_status_port or data_plane_barrier_release_at_full_fleet_width or storage_readiness_inventory_reads_are_bounded or fleet_cleanup_releases_emergency_disk_reserve_before_provider_teardown or isolated_backend or local_predeploy_skips_wmh or cloud_agentcard_payment_tasks_provide_onboarding_callback_env or fleet_shared_patch_remains_authoritative_until_transport_selection or fleet_patch_packages_clean_unpushed_head_from_fetchable_base or autoscaler_scale_down_cancels_pending_worker or fleet_registry_release_id_is_idempotent_with_other_records or refresh_deps_tracks_exact_created_snapshot or refresh_deps_applies_exact_workspace_before_rebuild or fetch_ref_restores_dirty_exact_sha or warm_deps_preflight or fresh_controller_reuses_only_proven_donor_dependencies or verified_legacy_snapshot or dependency_proof_publication or exact_volume_ownership_survives_delayed_visibility_and_failed_delete or exact_recovery_routes_quarantined_owner_to_guest_recovery_before_reapers or pre_fix_guest_runner_receipt_cannot_authorize_exact_reaper or exact_recovery_seals_actual_retained_owner_remote_evidence_paths or hub_transport or guest_shutdown_child_confirmation or exact_guest_recovery_archives_bound_child_token or exact_recovery_consumes_runtime_receipt_completed_absent_primary or exact_recovery_consumes_runtime_receipt_publishes_audited_release or fleet_lifecycle_receipt_requires_final_registry_retirement or watchdog_collects_cancelled_artifact_after_bounded_shutdown or terminal_projection_preserves_benchmark_outcome or boot_driver_state_write_failure or driver_cleanup_persists_evidence_in_fresh_data_directory or driver_cleanup_requires_current_stack_receipt_on_normal_completion or autoscaled_worker_uses_authenticated_fetch_ref_helper or terminal_projection_empty_tasks or terminal_projection_rejection_removes_all_artifacts or status_recovery_read_closes_descriptor or cloudbench_recovery_review or migration or migrated_registry or owned_worker_volume or composite_result_finalizes_each_exact_root or minted_dispatch_preserves_live_root_observer or evaluated_wrapper_completion_publishes_once or data_plane_mirror_reads_current_owner_port or fleet_publishes_evaluation_before_teardown or boot_terminal_runtime_evidence_collects_complete_logs or cloudbench_worker_snapshot or quiesced_guest_writes_hashed_authoritative_zero_allocated_receipt'
if [ -z "$CHANGED_AGENTS" ]; then
  cd agents && ./venv/bin/python scripts/run_blackbox_tests.py benchmark
fi
```

The controller commands above must pass. The agents `benchmark` blackbox domain
must also pass exactly once: Step 4g's agents coverage already runs it whenever
`$CHANGED_AGENTS` is non-empty, so Step 4cb runs it directly only when agents
coverage was skipped. Never launch the same controller-owning domain in both
parallel lanes; they share local lock and fixture state. When `$CHANGED_AGENTS`
is non-empty, wait for Step 4g to finish before starting the controller
commands above. This operational
verification wiring is pre-authorized by Step 0p and must never pause for human
approval.

## Step 4c: Credential health check (runs unless explicitly overridden)

After all parallel Group 3 branches finish, validate every external credential
(E2B, Steel, Parallel.ai, Anthropic, OpenRouter, Supabase) with the focused test
below. The deterministic Step 4a batch excludes this provider-dependent domain,
so this runs exactly once and a provider outage can be retried without rerunning
all 91 instrumented back-end domains.

Step 4p launches the exact `run-deploy-stage credential-health` command with
`npx tsx src/tests/blackbox/integration-health.blackbox.ts`.

**If any hard credential is rejected** the error message names the exact env var to refresh and the provider dashboard URL. Escalate to the user immediately and do not proceed to Step 5 unless the user explicitly overrides that credential gate. If overridden, record the rejection as `⚠️ Overridden`, use the narrow gate-specific harness override, and continue every other check. Do not change production auth behavior merely to make a rejected credential appear healthy.

Anthropic/Claude is intentionally non-blocking in this gate: the probe should still run by default and report `WARN` on exhausted credits, rejected auth, or provider availability problems, but future deploys may proceed without human approval when only this provider fails. The optional `DEPLOY_GATE_OVERRIDES=credential-health:anthropic` path remains available when an operator wants an explicit audited skip instead of a live probe. Parallel.ai is also warn-only.

## Step 4h: Live Amplitude admin-health probe (no skip)

Run this once after all parallel Group 3 branches finish and before recording
the `runtime-blackbox` finish boundary. Step 4p launches the exact
`run-deploy-stage amplitude-live` command with the strict
`ADMIN_HEALTH_LIVE_ONLY=1` and `BLACKBOX_TEST_CONCURRENCY=1` environment.

This starts an isolated local backend and executes only the strict weekly
admin-health case. Missing credentials fail closed; all six Amplitude funnel
steps must be `ready` with real counts. A 429 blocks deploy, but its rerun
repeats only this focused probe—not the complete coverage suite.

## Step 4p: Concurrent focused live probes

The credential and Amplitude probes are independent and both read-only, so they
run concurrently under one foreground supervisor; a failing lane cannot
interrupt or hide the sibling's evidence. The chat-router-failover live probe
starts after the Amplitude probe exits, because both boot the blackbox
runner's db push and trigger hooks:

```bash
python3 scripts/run_deploy_live_probes.py
```

All three stage records must pass before closing the `runtime-blackbox`
boundary.

`chat-router-failover-live` replays the e8f2279b address-correction follow-up
on its exact 30-message router context during a simulated Cerebras-wide
stall, with the real OpenRouter GLM failover as the only path that can serve.
It must run on the OpenRouter account `back-end/.env` configures, escalate on
router attempt 1, and start the workflow with a goal anchored on the corrected
address and not on the rejected one. A miss OpenRouter caused (the connection
opened but no response headers came, or no first content within the 14.2s
pre-content budget) is re-probed once 60s later. A second miss, or any other
failure, blocks the deploy. A block means the failover could not serve that
turn at that moment: diagnose it from the printed host, connect, and response
timings and the `openrouter_fast_chat.end` records before rerunning.

## Step 4r: Cold-seed memory ratchet (no skip)

Measure five full cold seeds against the newest cached production dump. Every
run gets a fresh target database and must pass the source/target fidelity
fingerprints for Cookies, LocalStorage, IndexedDB, and Cache Storage. The gate
uses the OS-level maximum resident set size; failed or fidelity-mismatched runs
never count as a favorable low-memory sample.

```bash
cd back-end && bash ../scripts/run-deploy-stage seed-memory-ratchet -- \
  bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget
```

The checked-in budget is the maximum of the last five stable runs plus exactly
20% headroom, rounded up. If this gate fails, reduce the seed's peak and re-run
all five measurements. Never raise the budget or a machine size to make it pass.

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
      pgvector/pgvector:pg16 >/dev/null
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

This stack is deliberately **capture-only** (`run.sh` defaults
`BLACKBOX_TEST_REPLAY_OUTBOUND` to `0`), and
`scripts/tests/semantic-deploy-gate.test.sh` fails the build if `/deploy` adds
the replay opt-in back. Do not point a `BLACKBOX_TEST_USE_EXISTING_BACKEND=1`
blackbox run at it: `back-end/scripts/run-blackbox-tests.sh` rejects a
capture-only existing backend by design (pinned by
`scripts/tests/blackbox-existing-replay-gate.test.sh`), so such a run fails
before it starts with `❌ Existing-backend blackbox requires outbound capture and
replay`. Blackbox lanes that need replay own their own backend instead — see
Step 6c.

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
green. Commit all intended files. CodeRabbit automatically reviews a new PR
once, but `.coderabbit.yaml` deliberately disables review-on-every-push. `/deploy`
owns every later review request so intermediate gate fixes cannot create an
unbounded reviewer loop.

Initialize the durable three-cycle ledger and the first explicit timing
boundary immediately before the push. If this branch already has a PR, request
the first incremental review manually after pushing; otherwise opening the new
PR starts the initial review automatically.

```bash
HEAD_SHA=$(git rev-parse HEAD)
EXISTING_PR=$(gh pr view --json number --jq .number 2>/dev/null || true)
python3 scripts/deploy_review_cycle.py start --reset --kind initial --head "$HEAD_SHA"
python3 scripts/record_factory_event.py deploy stage-start code-review
git push -u origin "$(git branch --show-current)"
# Create the PR using Step 8 when EXISTING_PR is empty, then set PR_NUMBER.
[ -z "$EXISTING_PR" ] || gh pr comment "$EXISTING_PR" --body '@coderabbitai review'
```

Do not push a second commit while a review cycle is open. Let the current
review finish, collect all Group 4 results, and batch every valid review/gate
fix into one stabilization pass. This keeps the PR HEAD immutable while the
exact-HEAD waiter is running.

Immediately after the PR exists, launch all applicable Group 4 lanes together
in one assistant message with separate parallel Bash tool calls:

1. Code review polling (Step 9).
2. Smoke benchmarks (Step 6; skip only under its documented classifier).
3. AgentCard lifecycle (Step 6a; skip only when its classifier is empty).
4. Semantic tests (Step 6b; never skip).
5. Claude Code E2B sandbox smoke (Step 6c; NEVER skip — runs on every deploy).

Matching Group 4 rows in `/factory-review` therefore share a real start phase.
Do not wait for one lane before starting another. All applicable lanes must be
green before merge. If any lane requires a code change, wait for the open review
to finish, batch all fixes, restart the Test Loop from Step 0, and relaunch the
applicable test lanes. Do not request another review until those lanes stabilize.
The later automated review cycle (CodeRabbit or Claude fallback) covers every commit accumulated since the prior review — not a human PR reviewer.

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

`scripts/run-predeploy-local` selects tasks via `agents/benchmarks/select_predeploy_benches.py` (identical selection to the cloud path, so they can't drift): **existing `smoke` always runs**, then **history gate for added canaries/path extras only** (last 3 eligibility attempts in `agents/benchmarks/history/task_attempts.jsonl` all passed; predeploy/worktree attempts excluded so assignment cannot self-invalidate), then a **category floor** (one history-qualified canary per floor category: payment, grep, sms, browser_stateful) plus **path-triggered depth** from the git diff, hard-capped at **20**. Before running it prints a clear selection report (`TOTAL SELECTED: N / 20`, plus skipped-for-history and uncovered floor categories). Hitting the hard cap prints a loud scream and drops extras (floor always fits or the gate fails closed). New catalog tasks auto-attach by `deploy_category` / tags — set `deploy_canary: true` to prefer a task as its category canary. Override the cap only with review via `PREDEPLOY_BENCH_CAP`. It then runs the selected set through `scripts/run-bench --local` with default concurrency 2 on the isolated stack, scheduling longest-recent-median first. `PREDEPLOY_LOCAL_CONCURRENCY` is an emergency/debug override; it does not change the selected task count or the 20-task ceiling. It exits non-zero unless every requested task passes, so the command IS the gate.

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

**ALL non-skipped Pre-Deploy smoke benchmarks must pass, with 0 failures.** The deploy-approved credential skip is a Claude Code benchmark whose preflight proves there are no synced Claude credentials and no pool token; the shared `ANTHROPIC_API_KEY` fallback is covered by the warn-only credential-health gate and does not satisfy this skippable smoke task. The standing AgentCard release-stall exception in Step 6a also applies when a selected payment canary encounters that exact state. These exceptions apply to future deploys without additional human approval. Claude Code task correctness remains hard-gated; only its repeatable prompt-cache telemetry floor is warn-only in `run-predeploy-local` and must be reported as a risk when it misses. On the local path, `run-predeploy-local` must exit 0 and every non-skipped task's FE link must show the agent actually ran. (Cloud alternate: the Hub run must be final — `live=false`, dispatch `completed` — and visible in Benchmarks → Runs.) Other timeouts, stalls, wrong tool usage, backend crashes, or failures must be diagnosed and fixed.

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
- Skipping or disabling tests, except the standing AgentCard release-stall exception in Step 6a (sandbox AND production) and two deploy-approved provider-funding smoke skips: (1) the Claude Code credential-unavailable smoke skip described above, and (2) the Codex E2B smoke (`codex-code` blackbox `smoke -- Codex completes task in real E2B sandbox`) when **every** Codex credential path (ChatGPT OAuth + the funded OpenAI key) is out of credits/quota. The Codex skip is automatic and self-verifying: `codexSmokeCreditSkipReason` (in `back-end/src/tests/blackbox/codex-credit-skip.ts`) converts that specific out-of-funds terminal state into a loud `SKIP` (never a silent pass) so the gate is not blocked by an external funding state, while every other Codex failure mode — crash, timeout, wrong output, and bare OAuth/token revocation (a re-auth issue, not a funding issue) — still hard-fails. Do NOT reach for the coarse `BLACKBOX_TEST_SKIP_DOMAINS=codex-code` bypass for the funding case; the in-test skip keeps the rest of the codex-code domain strict.

**Escalation is ONLY for:**

- Third-party providers returning error codes that indicate the account is out of credits/funds (e.g., "insufficient credits", "402", "quota exceeded") — EXCEPT (a) the Codex E2B smoke, which now auto-skips this funding state without human approval (see above); a Codex out-of-funds state no longer blocks the deploy gate, and (b) **the code-review providers (CodeRabbit / the Claude review fallback), which NEVER escalate for credits — see Step 9a, "Review-provider usage exhaustion"**. This escalation list is scoped to Step 6 smoke benchmarks and product-path providers; it does not govern the review gate.
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

This lane deliberately does NOT pin a compute lane. It previously set
`ROSE_EXCLUDE_ANTHROPIC_FAMILY=1` + `SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt`, which
forced every payment task onto GPT. Nothing in the payment path needs GPT, and
that pin coupled the gate to two unrelated failure modes: it required a
machine-local `~/.codex/auth.json` (so the gate was unrunnable on any machine
without `codex login`), and it made the gate fail outright whenever the
pay-as-you-go OpenAI key was out of credits — even with a perfectly healthy
claudeAuth subscription token available. Let normal pool selection choose the
compute lane so the gate tests the payment lifecycle rather than one provider's
billing state.

```bash
cd "$(git rev-parse --show-toplevel)"
CONDUCTOR_WORKSPACE_NAME="$CONDUCTOR_WORKSPACE_NAME" \
  BENCHMARK_SKIP_WMH_BUILD=1 \
  BENCHMARK_ATTEMPT_SUITE=predeploy \
  BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY=0 \
  BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=1 \
  bash scripts/run-deploy-stage agentcard-lifecycle -- \
  bash scripts/run-bench --local agent-payment-test-shop agent-payment-setup-resume agent-payment-idempotent-abandonment agent-payment-abandonment --bootstrap --max-concurrency 1 --no-dashboard
```

These four real-mode payment tasks never use the simulated World Model Harness.
The explicit opt-out prevents every fresh deploy workspace from downloading the
full trace archive and running a first-time GEPA build before the payment gate.

`BENCHMARK_COUNTS_FOR_DEPLOY_ELIGIBILITY=0` keeps these active-worktree attempts
out of the canary pass-streak history, exactly like `run-predeploy-local`. Without
it an unmerged branch's AgentCard failure (or a provider blip) evicted the payment
canaries from the smoke floor of every later deploy until three fresh passes.

The bootstrap must report an AgentCard sandbox pool of at least $500. This is
test-only float provisioned through the authenticated admin session; it does not
bypass Organization MCP in the purchase path. All non-skipped tasks must pass with
their full purchase, Stripe, AgentCard card, organization transfer, attention,
and cleanup assertions. A missing lifecycle snapshot, unapproved skip, unreclaimed
abandonment transfer, or unrefunded Stripe capture blocks deploy except for the
standing release-stall exception below. Record the
four task results and total cost in `TEST_REPORT`.

One exception is approved permanently for every future deploy and benchmark run:
the open AgentCard release stall in
`docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md`
is automatically a loud `⚠️⚠️ SKIPPED`, never PASS. No environment opt-in or renewed
human approval is required. This standing user instruction covers BOTH sandbox
and production (Step 13c), regardless of the Stripe payment's mode. It applies
when Rose closed the card with zero balance and is reclaiming while AgentCard
still reports that exact card's transfer `consumed` with `releasedCents=0`, in
the task's expected AgentCard mode. Other lifecycle, read, cancellation and
cleanup failures still fail. Report the skipped count and unreleased amount in
`TEST_REPORT` and the scorecard. The existing reconciliation deadline stays
unchanged; do not keep retrying the same confirmed stall every ten minutes,
mint another card to get a passing result, or ask the user to approve this
exception again. `BENCHMARK_SKIP_AGENTCARD_RELEASE_STALL=0` explicitly restores
strict behavior for release diagnostics. A skip does not release funds, refund
Stripe, or prove native cleanup; retain that liability and its evidence.

## Step 6b: Semantic tests + fix

Semantic tests exercise real user flows through Playwright/Chromium against the full local stack (backend + worker + **frontend**). They are the only gate that proves realtime broadcasts reach the UI and that the login path still works end-to-end.

**Semantic tests run on every /deploy unless the user explicitly overrides that gate.** This is independent of the smoke-benchmark change classifier: documentation-only, test-only, frontend-only, and backend-only deploys all run the complete semantic suite by default. A deploy changes production state even when the app diff is small, so the user-visible frontend contract is normally re-proven.

### Running semantic tests

With the full stack from Step 5 still running (backend, worker, **and frontend on `$SMOKE_FRONTEND_URL`**):

```bash
cd "$(git rev-parse --show-toplevel)"
CONDUCTOR_PORT=$(jq -er '.ports.backend' .context/services.json)
LOCAL_DB_PORT=$(jq -er '.database.runtime_port' .context/services.json)
# UI specs: four workers. Exclude the latency ratchet so Chromium renderer
# contention cannot become part of the product latency measurement (same split
# as chat-lifecycle-ratchet.yml).
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 \
  LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh
# Latency ratchet: one worker, sequential samples across every chat path.
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
  bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh chat-lifecycle-latency
```

The runner generates one authenticated session per Playwright invocation. UI specs run on four workers with the latency ratchet excluded (`SEMANTIC_GREP_INVERT`). The latency ratchet then runs alone on one worker so renderer contention cannot become part of the product latency measurement — the same split as `chat-lifecycle-ratchet.yml`. Inside the lifecycle spec, `direct_answer`, `web_search`, `agent_plan`, and `agent_execute` each take five independent samples. Every sample must reach its functional terminal state without missed milestones or uncaught errors. Six seconds is a reporting target: preserve measured p50/max/smoothness and warn on individual target misses; a completed slow sample alone does not reject the deploy. Functional failures, missing terminal state, cleanup failures and applicable user-authorized whole-run limits remain failures.

This runs every `.spec.ts` under `front-end/tests-e2e/` via headless Chromium. To run a single test:

```bash
LOCAL_DB_PORT=$LOCAL_DB_PORT BACKEND_PORT=$CONDUCTOR_PORT FRONTEND_PORT=$((CONDUCTOR_PORT + 1)) \
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

## Step 6c: Claude Code E2B sandbox smoke (NO SKIP — real E2B sandbox)

**This gate is NON-SKIPPABLE. It runs on every `/deploy` regardless of the change
classifier or which paths changed.** It is the only gate that proves the Claude
Code agent path works end-to-end through a real E2B sandbox: DB credential read →
decrypt → sandbox create → `ws-server.mjs` overlay → Claude Code CLI invocation →
Anthropic → completion. A regression here (e.g. a CLI-arg contract break like the
2026-08-05 "Input must be provided … when using --print" incident, where the CLI
ignored the positional prompt under `--output-format stream-json` and every
session exited 1) is invisible to the ordinary back-end blackbox suite because
Step 4a's coverage run deliberately keeps `BLACKBOX_SMOKE` unset and never spins a
real sandbox. Do NOT downgrade this to WARN, gate it behind a change classifier,
or skip it because "claude-code wasn't touched."

With the full stack from Step 5 still running, resolve its actual backend and
database ports from the live service manifest. Create the separate local
database required by the standalone blackbox runner. This command runs in a
fresh shell and chooses the runtime port for Docker or system Postgres:

```bash
cd "$(git rev-parse --show-toplevel)"
. scripts/lib/workspace-env.sh
normalize_conductor_workspace_env
STACK_PORTS=$(bash scripts/resolve-deploy-stack-db.sh) || exit 1
read -r CONDUCTOR_PORT SMOKE_DB_PORT <<< "$STACK_PORTS"
export CONDUCTOR_PORT
E2B_DB_NAME="victoria_$CONDUCTOR_WORKSPACE_NAME"
if ! psql "postgresql://postgres:postgres@localhost:$SMOKE_DB_PORT/$E2B_DB_NAME" \
  -At -c 'SELECT 1' >/dev/null 2>&1; then
  PGPASSWORD=postgres createdb -h localhost -p "$SMOKE_DB_PORT" -U postgres "$E2B_DB_NAME"
fi
cd back-end && BLACKBOX_SMOKE=1 \
  BLACKBOX_TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:$SMOKE_DB_PORT/victoria_$CONDUCTOR_WORKSPACE_NAME" \
  bash ../scripts/run-deploy-stage claude-code-e2b-smoke -- \
  bash scripts/run-blackbox-tests.sh claude-code
```

This lane launches **its own** backend on purpose. It must not be pointed at the
Step 5 semantic stack with `BLACKBOX_TEST_USE_EXISTING_BACKEND=1`: that stack is
capture-only by contract, and `run-blackbox-tests.sh` rejects a capture-only
existing backend before any database work
(`scripts/tests/blackbox-existing-replay-gate.test.sh` pins that rejection, and
`scripts/tests/semantic-deploy-gate.test.sh` forbids re-adding the replay opt-in
to the shared stack). The two contracts are only satisfiable together by letting
this lane own its backend, which also keeps it runnable when the shared stack is
busy or down. It still reuses the workspace Postgres, so it stays cheap.

### Pass criteria

The domain must report `ALL CLAUDE-CODE BLACK-BOX TESTS PASSED`, and the summary
must include `PASS  smoke -- Claude Code answers 2+2 (real E2B sandbox)`. The
smoke phase (`BLACKBOX_SMOKE=1`) actually creating a sandbox and observing
`CLAUDE_E2B_DONE` is mandatory — a run that prints `Skipping Claude Code smoke
tests (BLACKBOX_SMOKE!=1)` does NOT satisfy this gate.

### Requirements (surface, do not mask)

- `E2B_API_KEY` must be set (backend `.env`).
- A usable Claude credential for `DEV_USER_ID` must be resolvable — on macOS the
  smoke syncs it from the `Claude Code-credentials` Keychain item; otherwise a
  pooled `claude_code` integration must exist. If the credential is genuinely
  unavailable this gate FAILS (it is not a silent skip); resolve the credential
  rather than bypassing the gate.

### On failure

Follow RCA: reproduce the claude-code session locally (a faithful harness that
overlays `e2b-templates/claude-code/ws-server.mjs` onto a real sandbox and runs
the CLI reproduces sandbox-level failures the standard blackbox cannot), fix the
root cause, and re-run this exact command until it is green. The permanent
structural guard `back-end/src/tests/structural/claude-code-ws-prompt-stdin.test.ts`
cements the prompt-delivery contract this smoke exercises.

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

# ║ 6a. AgentCard lifecycle: all pass or approved warning skips ║

# ║ lifecycle surface changed ║

# ║ 6b. Semantic tests: 100% pass on every /deploy; never skipped. ║

# ║ Includes four chat paths × five full-lifecycle samples. ║

# ║ Functional completion and owned cleanup are mandatory; ║

# ║ completed misses of the six-second reporting target warn. ║

# ║ 6c. Claude Code E2B sandbox smoke: PASS on every /deploy; never ║

# ║ skipped. Real sandbox; `smoke -- Claude Code answers 2+2` must ║

# ║ PASS (a BLACKBOX_SMOKE!=1 skip does NOT satisfy this gate). ║

# ║ ║

# ║ If ANY test has ANY failure, you are BLOCKED. ║

# ║ Fix it or escalate to the user. Do NOT proceed. ║

# ║ ║

# ║ INVALID EXCUSES (do NOT use these to justify proceeding): ║

# ║ - "Pre-existing" / "not related to my changes" ║

# ║ - "Infrastructure issue" / "flaky" / "resource contention" ║

# ║ - "The code changes don't touch agent/Temporal code" (check the ║

# ║ Step 6 table — back-end/ changes ALSO require ║

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

Never use `gh pr checks --watch` here: it watches unrelated PR checks, and the
old stale-check loop queried `statusCheckRollup` from a REST endpoint that does
not expose that field. Wait only for CodeRabbit on the immutable HEAD stored in
the open cycle. GitHub statuses are commit-scoped, so legacy StatusContext
successes do not need a `startedAt` timestamp to prove freshness.

```bash
REVIEW_STATE=$(python3 scripts/deploy_review_cycle.py status)
REVIEW_HEAD=$(printf '%s' "$REVIEW_STATE" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["cycles"][-1]["head"])')
REVIEW_KIND_OPEN=$(printf '%s' "$REVIEW_STATE" | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["cycles"][-1]["kind"])')
# Optional Graphide review (Step 9b): request it once, on the initial cycle only.
GRAPHIDE_TS=""
if [ "$REVIEW_KIND_OPEN" = initial ]; then
  GRAPHIDE_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh pr comment "$PR_NUMBER" --body '@graphide-review review' >/dev/null 2>&1 || GRAPHIDE_TS=""
fi
bash scripts/wait-for-code-review --pr "$PR_NUMBER" --head "$REVIEW_HEAD" --timeout 600 --poll 5
```

This fails if the PR HEAD changes while waiting, preventing an older success
from satisfying the gate. **A green check alone does not prove a substantive
review happened.** Once it returns, read reviews from ALL three comment
locations:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments
```

Filter reviews/comments by `commit_id == REVIEW_HEAD` / `original_commit_id ==
REVIEW_HEAD`. For issue comments, use the open cycle's `started_at` from
`.context/deploy-review-cycle.json`. Never use the current mutable shell time as
a freshness boundary.

### Step 9a: Verify CodeRabbit delivered a substantive review

Inspect the newest CodeRabbit-authored content from all three endpoints. Treat CodeRabbit as unavailable and run the Claude fallback for the same `REVIEW_HEAD` when any of these is true:

- The check is missing, failed, or timed out.
- The newest bot output contains `Review limit reached`, `rate limited`, `usage spending cap`, `review skipped`, or a service/internal error.
- The check is green but there is no substantive review result for `REVIEW_HEAD`. A quota/error comment is not a review.
- The `@coderabbitai review` comment was posted by a bot account (for example `cursor[bot]` when a Cloud Agent comments through its PR tool). CodeRabbit silently ignores bot-authored commands, so the push only produces `Review skipped: incremental reviews are disabled` and no review follows. Go straight to the fallback instead of re-requesting.

Do not repeatedly request more CodeRabbit reviews during a quota window. Trigger exactly one Claude review for `REVIEW_HEAD` by toggling the opt-in label. The fallback remains part of the already-open lifecycle; it does not consume another review cycle:

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
    --jq ".[] | select(.headSha == \"$REVIEW_HEAD\" and .createdAt > \"$FALLBACK_TS\") | .databaseId" \
    | head -1)
  [ -n "$FALLBACK_RUN_ID" ] && break
  sleep 15
done
[ -n "$FALLBACK_RUN_ID" ] || { echo "Claude fallback did not start" >&2; exit 1; }
gh run watch "$FALLBACK_RUN_ID" --exit-status
```

After success, read the three comment endpoints again and filter at `FALLBACK_TS`. The official code-review plugin posts only findings scoring at least 80; a successful workflow with no findings comment means no high-confidence issues were found. If the workflow fails for a **repairable** reason (bad checkout, workflow bug, transient 5xx, missing/rotated `CLAUDE_CODE_OAUTH_TOKEN` secret), do not merge — inspect `gh run view "$FALLBACK_RUN_ID" --log-failed`, repair the fallback, and rerun it for the same HEAD. If it failed from **usage exhaustion**, do not repair and do not rerun — go straight to the clause below.

### Review-provider usage exhaustion: TANK THROUGH, never ask

**This is pre-authorized. Do NOT stop. Do NOT ask the user for permission, approval, an override, a top-up, or a decision. Do NOT wait out a quota window. Record it and keep deploying.** The review gate exists to catch code defects, not to block on billing state; the agent cannot fix user-owned billing, so pausing to ask only stalls the deploy at zero information gain. This clause **overrides** every contrary instruction in this command — the Step 6 "Escalation is ONLY for … out of credits/funds" list, the "credential/billing escalation" halt in Step 0, and the "if the workflow fails, do not merge" line above. Escalating a review-credit block is a deploy defect, not caution.

**Trigger — either reviewer is usage-exhausted and the other cannot cover it:**

- CodeRabbit: rate-limit, spending cap, "Review limit reached", or a quota comment in place of a review.
- Claude fallback: provider usage exhaustion. The signature is unmistakable — `is_error:true` with `num_turns:1`, `duration_ms` ~2000, and `total_cost_usd:0`, and/or an Anthropic "credit balance is too low" / 400 / 429 / spending-cap error. ~2s + 1 turn + $0 = provider-blocked.

Distinguish this from a **repairable** fallback failure (bad checkout, workflow bug, transient 5xx, revoked secret) — those you still fix and rerun. Exhaustion is not repairable by you.

**What to do, mechanically:**

1. Record in `TEST_REPORT`:
   `Code Review | ⚠️ Skipped | reviewers usage-exhausted (CodeRabbit <reason>; Claude fallback <reason>)`
2. Close the open cycle as **clean** — this is the only result that satisfies `require-mergeable`:
   ```bash
   python3 scripts/deploy_review_cycle.py finish --head "$REVIEW_HEAD" --result clean
   ```
   **Never use `--result unavailable`.** It is an accepted value but it hard-fails
   `require-mergeable` at Phase 3 entry and again at Step 12, and it cannot be undone in
   place (a second `finish` and a re-`start` on the same HEAD are both rejected) — you
   would have to `start --reset` or hand-edit `.context/deploy-review-cycle.json`. The
   ledger has no `--note`/`--reason` flag; the note lives in `TEST_REPORT` and the PR body.
3. Surface the exhaustion and its concrete risk (**this diff merged unreviewed**) in the PR body and in the final handoff.
4. **Proceed to merge.** Do not open a new review cycle for the same HEAD.

**Still true:** never label an unavailable review as passing (the `⚠️ Skipped` row is mandatory — a silent `clean` is misreporting); never use this path to skip a reviewer that _did_ run and returned findings; and CodeRabbit merely declining to re-review an already-seen commit is **not** exhaustion — that is a false-green, so force `@coderabbitai full review` instead. If a reviewer can be restored with a zero-touch retry you already have in hand, prefer that — but never block, and never ask, to obtain one.

Remove the fallback label after a successful review so later pushes do not spend Claude quota unless the fallback is explicitly requested again:

```bash
gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/labels/claude-review-fallback \
  -X DELETE >/dev/null 2>&1 || true
```

### Step 9b: Read the optional Graphide review (skippable, never blocks)

Graphide Review (GitHub App `graphide-review`) reviews a PR when someone
mentions `@graphide-review` on it; Step 9 posted that request for the initial
cycle's `REVIEW_HEAD`. Its result is a check run on that commit (PR comments are
a per-repository Graphide setting that starts off). It is advisory, not a merge
gate. After CodeRabbit/Claude reach a terminal result for the same HEAD, and
**before** the Step 10 `finish`, read it with the time left in its 10-minute
budget:

```bash
GRAPHIDE_JSON='{"status":"skipped","reason":"not requested (only the initial cycle requests Graphide)"}'
if [ -n "$GRAPHIDE_TS" ]; then
  GRAPHIDE_LEFT=$(python3 -c 'import sys
from datetime import datetime as D, timezone as Z
t = D.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=Z.utc)
print(max(30, int(600 - (D.now(Z.utc) - t).total_seconds())))' "$GRAPHIDE_TS")
  GRAPHIDE_JSON=$(bash scripts/read-graphide-review --pr "$PR_NUMBER" --head "$REVIEW_HEAD" \
    --since "$GRAPHIDE_TS" --timeout "$GRAPHIDE_LEFT" --poll 15)
fi
printf '%s\n' "$GRAPHIDE_JSON"
```

The reader always exits 0 and prints one JSON object. `status: skipped` (no
request, timeout, errored/cancelled check, unreadable API, HEAD moved) →
record `Graphide Review | ⚠️ Skipped | <reason>` in `TEST_REPORT` and continue;
never wait longer, re-request, or ask. `status: completed` → read its check-run
summary/text/annotations and any bot reviews/comments, then classify each
finding:

- **Fix** only a finding that is BOTH high-confidence (you confirmed it against
  the code, ideally with a reproducing test) AND critical to app function:
  crash, data loss/corruption, security hole, or a broken core user flow.
- **Note, do not fix** everything else (style, refactors, speculative or
  low-confidence issues, non-critical edge cases): list it in `TEST_REPORT` and
  the PR body. This narrower bar overrides Step 10's "fix ALL valid issues" for
  Graphide-only findings.

Record `Graphide Review | ✅ Read | <N> findings, <K> fixed, <N-K> noted`.

**Ordering with the bounded review cycles:** Graphide is requested only on
cycle 1 (`initial`), and its fixes join the cycle-1 stabilization batch. If
cycle 1 is otherwise clean but a Graphide finding qualifies, close cycle 1 as
`findings` and fix it; the fix is reviewed by cycle 2 (`incremental`), so it
never needs a cycle beyond the existing three. Graphide is never requested on
cycles 2 or 3, so it cannot create a HEAD after the last allowed cycle. The
10-minute budget (counted from the request) bounds how long cycle 1's `finish`
can wait for it; a Graphide result arriving later is ignored for this deploy.
If Graphide posted inline comments, reply `[FIXED] <solution>` or
`[NOTED] below the high-confidence critical bar` instead of `[IGNORED]`.

## Step 10: Handle review results

Look across all three endpoints for review feedback from CodeRabbit or the Claude fallback. Either reviewer may post findings as formal reviews or regular comments. Fold in the Step 9b Graphide classification for cycle 1 before choosing the cycle result.

As soon as a reviewer reaches a terminal result (clean or findings), record the
review lifecycle finish before proceeding or fixing anything, then close the
same exact HEAD in the durable ledger:

```bash
python3 scripts/record_factory_event.py deploy stage-finish code-review
# Choose exactly one after classifying every valid finding:
python3 scripts/deploy_review_cycle.py finish --head "$REVIEW_HEAD" --result clean
# python3 scripts/deploy_review_cycle.py finish --head "$REVIEW_HEAD" --result findings
```

The normal budget is the initial review plus one batched incremental review. A
third verification review is allowed only when the second review found a valid
issue that required another code change. `deploy_review_cycle.py` hard-stops a
fourth cycle. If cycle three still has valid findings, record `deploy outcome
blocked` and stop this deploy as **review-unstable**; never merge an unreviewed
fix. Stabilize the branch as development work, then start a fresh `/deploy`.

- **APPROVED / no issues** → close the cycle as `clean`. Proceed only when every
  test lane is green and `HEAD == REVIEW_HEAD`.
- **CHANGES_REQUESTED / valid findings** → close the cycle as `findings`, reply
  to every comment, and fix all findings together with any gate failures. **Do
  not push each fix.** Re-run the full Test Loop locally, commit the complete
  stabilization batch, then push once and request one incremental review.
- **GRAPHIDE CRITICAL FINDING** (Step 9b, cycle 1 only) → treat as a valid
  finding: close as `findings` and include the fix in the same batch. Graphide
  skipped or only non-critical findings → no effect on the cycle result.
- **CODE RABBIT UNAVAILABLE** (quota, spending cap, rate limit, service failure, or false-green check) → use the Claude fallback from Step 9a.
- **BOTH REVIEWERS USAGE-EXHAUSTED** → close the cycle `--result clean`, record the
  `⚠️ Skipped` row, and keep going. Never stop to ask — see Step 9a,
  "Review-provider usage exhaustion: TANK THROUGH, never ask."
- **REVIEW SKIPPED** (e.g., "Too many files!") → finish the current immutable
  HEAD through the Claude fallback. Do not push filter edits while its review
  cycle is open. CodeRabbit Free caps reviews at 150 files; the list below is
  the canonical safe-filter set for a later stabilized commit because those
  paths are already gated locally:
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
  If the projected count is still ≥150 after applying the canonical set, split
  the PR or upgrade CodeRabbit; do not weaken the review.

After a stabilization batch is fully green, archive any completed active plan
using Step 11 **before** capturing the final review HEAD. Include that
administrative commit in the same batch. Then open the next bounded review
cycle:

```bash
REVIEW_HEAD=$(git rev-parse HEAD)
REVIEW_COUNT=$(python3 scripts/deploy_review_cycle.py status | python3 -c \
  'import json,sys; print(len(json.load(sys.stdin)["cycles"]))')
[ "$REVIEW_COUNT" -lt 3 ] || {
  python3 scripts/record_factory_event.py deploy outcome blocked
  python3 scripts/factory_ledger.py publish
  echo "review cycle cap reached; deploy is review-unstable" >&2
  exit 1
}
REVIEW_KIND=incremental
[ "$REVIEW_COUNT" -lt 2 ] || REVIEW_KIND=verification
python3 scripts/deploy_review_cycle.py start --kind "$REVIEW_KIND" --head "$REVIEW_HEAD"
python3 scripts/record_factory_event.py deploy stage-start code-review
git push origin HEAD
gh pr comment "$PR_NUMBER" --body '@coderabbitai review'
# Return to Step 9. Do not mutate or push HEAD until this cycle is terminal.
```

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

Only enter this phase when the Test Loop is green and the exact current HEAD has
a clean completed review. Enforce that invariant rather than trusting prose:

```bash
python3 scripts/deploy_review_cycle.py require-mergeable --head "$(git rev-parse HEAD)"
```

**Main moved after a clean final review (sync-only HEAD).** When main must be
merged after the last clean cycle (for example, the generated
`docs/rca/INDEX.md` conflicts), merge `origin/main`, regenerate generated files
(`python3 scripts/rca_archive.py reindex`), commit, re-run the gates the merged
tree affects, then record the audited inheritance instead of hand-editing the
ledger:

```bash
python3 scripts/deploy_review_cycle.py inherit-sync --head "$(git rev-parse HEAD)" --base origin/main
```

It refuses unless the latest real review is clean, every new first-parent
commit is a merge of history already on the base, the branch-only diff
(generated files excluded) is byte-identical to the reviewed diff, and every
file the sync changed was changed on the base or is generated. Its entry does
not count toward the review-cycle cap. Any refusal means the change needs a
real review cycle.

## Step 11: Archive plan (before the final review)

Check if there's an active plan related to this branch's work:

```bash
ls docs/plans/active/ 2>/dev/null
```

If a related plan exists in `docs/plans/active/`, it must be archived before
the final review HEAD is captured:

1. Move it to `docs/plans/completed/`:
   ```bash
   git mv docs/plans/active/<plan-file>.md docs/plans/completed/<plan-file>.md
   ```
2. Commit it into the stabilization batch, but do not push it separately:
   ```bash
   git add docs/plans/active/ docs/plans/completed/
   git commit -m "docs: archive plan to completed"
   ```

If this step discovers an active plan after Phase 3 has already started, leave
Phase 3 and return to Step 10. The final reviewed HEAD must include the archive
commit even though CodeRabbit path filters exclude documentation.

## Step 11a: Cleanup stale workspaces

Terminate orphaned Temporal workflows and processes from archived Conductor workspaces. This only kills resources from **archived** workspaces — prod and all active workspaces are untouched.

```bash
cd "$(git rev-parse --show-toplevel)/back-end" && npx tsx scripts/cleanup-stale-workspaces.ts
```

This is best-effort — if it fails (e.g., no Temporal API key, no Docker), proceed to merge anyway.

## Step 12: Merge

**Never push an unreviewed commit immediately before merge.** Recorded smoke
durations, plan archives, and test-loop fixes must all have been included in the
stabilization batch reviewed in Step 10. If local commits remain, return to the
Test Loop and Step 10 instead of merging:

```bash
if [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ]; then
  echo "unpushed commits exist after final review; return to Step 10" >&2
  exit 1
fi
python3 scripts/deploy_review_cycle.py require-mergeable --head "$(git rev-parse HEAD)"
```

Immediately before merging, start the production-verification lifecycle:

```bash
python3 scripts/record_factory_event.py deploy stage-start production-verify
```

Merge without deleting the branch. Do not delete the local branch or the remote branch unless the user explicitly asks for that.

```bash
gh pr merge <PR_NUMBER> --merge
DEPLOY_MERGED_SHA=$(gh pr view <PR_NUMBER> --json mergeCommit --jq '.mergeCommit.oid')
[ -n "$DEPLOY_MERGED_SHA" ] ||
  { echo "❌ Could not resolve the exact merge commit for PR <PR_NUMBER>"; exit 1; }
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

Determine which deploy workflows are relevant based on what files changed in the PR. Check using `git diff "$DEPLOY_MERGED_SHA^1" "$DEPLOY_MERGED_SHA" --name-only`; never substitute the latest `main`, which may already belong to a later PR:

- Runtime changes selected by `scripts/classify-agent-runtime-changes.sh`, or a
  change to `.github/workflows/deploy-agents.yml` itself → poll
  `deploy-agents.yml`. Additive tests, benchmarks, docs, and coverage harnesses
  under `agents/` do not trigger that workflow and must not be polled.
- Changes in `back-end/` → Render auto-deploys (no workflow to poll). **Do NOT just "wait ~60s" — run Step 13a to confirm the merged commit went live AND the app is functionally healthy.**
- Changes in `front-end/` → Vercel auto-deploys. Wait for a successful GitHub deployment status tied to the merged SHA; a fixed sleep is not proof that the new frontend is live.
- Changes in `mac-app/` → check if PR had `MAC-APP-RELEASE` label; if so, poll `release-mac-app.yml`

Start every applicable provider lane concurrently in separate foreground tool
calls immediately after merge: Fly, Render, Vercel, and Mac release are
independent. Do not wait for one provider before launching another. Each lane
must record its exact boundary with the matching pair below; a failed lane has
no finish event and leaves the aggregate production lifecycle incomplete:

- Fly: `deploy production-start fly` → `deploy-agents.yml` watch → `deploy production-finish fly`
- Render: `deploy production-start render` → exact-SHA live poll → `deploy production-finish render`
- Vercel: `deploy production-start vercel` → exact-SHA deployment poll → `deploy production-finish vercel`
- Mac: `deploy production-start mac-release` → `release-mac-app.yml` watch → `deploy production-finish mac-release`

Prefix each marker above with
`python3 scripts/record_factory_event.py`. For example, the full Fly start is
`python3 scripts/record_factory_event.py deploy production-start fly` and its
full finish is
`python3 scripts/record_factory_event.py deploy production-finish fly`; use the
same form for Render, Vercel, and Mac release.

Run only the applicable pairs. Put the start immediately before that lane's
poll/watch command and the finish immediately after its successful terminal
status. For an activation-gated Fly deploy, the finish marker belongs after the
exact cutover releases its lock and the workflow completes in Step 13ab. These
are telemetry calls, not extra gates.

For an explicitly selected `AGENT_DEPLOY_MODE=existing-process`, use the
[existing-Machine process route](../../docs/existing-worker-process-deployment.md).
It requires the same exact merged source, MIN8, native candidate validation and
activation-before-pointer proof, plus durable backend recovery and native resource
qualification. Its old workers remain served; it never invokes Machine retirement
or the classic force-migration fallback. A held automatic workflow is not a passed
CI run: record the actual controller receipts and lane lifecycle below. All other
production gates remain mandatory. This is an operational deployment mode, not a
waiver of a failed gate.

Resolve and retain the exact agent deployment attempt whenever the canonical
cutover condition is true. The run ID plus run attempt is the
deployment-scoped Temporal activation token; a prior rollout of the same Git
SHA cannot authorize it:

```bash
FINAL_CHANGED=$(git diff --name-only "$DEPLOY_MERGED_SHA^1" "$DEPLOY_MERGED_SHA")
FINAL_CHANGED_AGENTS=$(printf '%s\n' "$FINAL_CHANGED" | grep -E '^agents/' || true)
CHANGED_AGENT_RUNTIME=$(printf '%s\n' "$FINAL_CHANGED_AGENTS" |
  bash "$(git rev-parse --show-toplevel)/scripts/classify-agent-runtime-changes.sh")
CHANGED_DEPLOY_AGENTS_WORKFLOW=$(printf '%s\n' "$FINAL_CHANGED" |
  grep -F '.github/workflows/deploy-agents.yml' || true)
AGENT_CUTOVER_REQUIRED=0
if [ -n "$CHANGED_AGENT_RUNTIME$CHANGED_DEPLOY_AGENTS_WORKFLOW" ]; then
  AGENT_CUTOVER_REQUIRED=1
fi

DEPLOY_ROOT="$(git rev-parse --show-toplevel)"
if [ "$AGENT_CUTOVER_REQUIRED" = "1" ]; then
  if [ "${AGENT_DEPLOY_MODE:-cooperative}" = "existing-process" ]; then
    python3 scripts/record_factory_event.py deploy production-start fly
    # Complete the signed staging and canonical validation sequence in the route
    # guide first. These retained exact-intent receipts survive interruptions.
    : "${WORKER_PROCESS_PLAN:?exact saved existing-host plan required}"
    : "${WORKER_PROCESS_VALIDATION:?canonical native candidate receipt required}"
    cd "$DEPLOY_ROOT/back-end"
    npx tsx scripts/deploy-existing-worker-processes.ts activate --execute \
      --plan "$WORKER_PROCESS_PLAN" --validation-receipt "$WORKER_PROCESS_VALIDATION"
else
  python3 scripts/record_factory_event.py deploy production-start fly
  AGENT_DEPLOY_RUN_ID=""
  for i in $(seq 1 120); do
    AGENT_DEPLOY_RUN_ID=$(gh run list \
      --workflow deploy-agents.yml \
      --branch main \
      --limit 30 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$DEPLOY_MERGED_SHA\") | .databaseId" |
      head -1)
    [ -n "$AGENT_DEPLOY_RUN_ID" ] && break
    sleep 5
  done
  [ -n "$AGENT_DEPLOY_RUN_ID" ] ||
    { echo "❌ Exact deploy-agents run did not start"; exit 1; }
  AGENT_DEPLOY_RUN_ATTEMPT=$(gh api "repos/{owner}/{repo}/actions/runs/$AGENT_DEPLOY_RUN_ID" \
    --jq '.run_attempt')
  AGENT_DEPLOYMENT_TOKEN="${AGENT_DEPLOY_RUN_ID}-${AGENT_DEPLOY_RUN_ATTEMPT}"
  echo "✅ Agent deployment token: $AGENT_DEPLOYMENT_TOKEN"

  APP=$(sed -nE 's/^app = "([a-z0-9-]+)"/\1/p' "$DEPLOY_ROOT/agents/fly.toml")
  # The database FIFO owns both manual controllers and GitHub runs. A later
  # run waits for its predecessor; it never steals that predecessor's bank.
  cd "$DEPLOY_ROOT/back-end" && source .env
  AGENT_SURFACE_HASH=$(python3 "$DEPLOY_ROOT/scripts/agent_workflow_surface_hash.py")
  python3 "$DEPLOY_ROOT/scripts/record_factory_event.py" deploy stage-start cooperative-cutover
  AGENT_CUTOVER_CONCLUSION=""
  for i in $(seq 1 540); do
    AGENT_DEPLOY_STATE=$(gh run view "$AGENT_DEPLOY_RUN_ID" \
      --json status,conclusion --jq '[.status, (.conclusion // "none")] | join("|")')
    IFS='|' read -r AGENT_DEPLOY_STATUS AGENT_CUTOVER_CONCLUSION <<<"$AGENT_DEPLOY_STATE"
    if [ $((i % 6)) -eq 1 ]; then
      node --import tsx scripts/worker-deployment-queue.ts head --app "$APP"
    fi
    if [ "$AGENT_DEPLOY_STATUS" = completed ]; then break; fi
    sleep 10
  done
  [ "$AGENT_DEPLOY_STATUS" = completed ] || {
    echo "CI is still active; retain its job, clocks and Machines and continue observing"
    exit 1
  }
  AGENT_DEPLOYMENT_JOB_ID=$(gh run view "$AGENT_DEPLOY_RUN_ID" --log | \
    sed -nE 's/.*Queued production worker deployment ([a-f0-9]{64}).*/\1/p' | sort -u)
  [[ "$AGENT_DEPLOYMENT_JOB_ID" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Exact deployment job was not recovered from this run's log"; exit 1;
  }
  if [ "$AGENT_CUTOVER_CONCLUSION" != success ]; then
    echo "Original CI result remains $AGENT_CUTOVER_CONCLUSION; resuming its saved deployment"
    node --import tsx scripts/worker-deployment-queue.ts run \
      --job-id "$AGENT_DEPLOYMENT_JOB_ID" -- python3 ../scripts/worker_pool_cutover.py
  fi
  python3 "$DEPLOY_ROOT/scripts/record_factory_event.py" deploy stage-finish cooperative-cutover

fi
fi
```

For other relevant GitHub Action workflows, wait for the new run to appear then
watch it:

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
  python3 scripts/record_factory_event.py deploy production-start vercel
  MERGED_SHA="$DEPLOY_MERGED_SHA"
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
  python3 scripts/record_factory_event.py deploy production-finish vercel
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
python3 scripts/record_factory_event.py deploy production-start render
cd "$(git rev-parse --show-toplevel)/back-end" && source .env
MERGED_SHA="$DEPLOY_MERGED_SHA"   # immutable merge commit captured in Step 12
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
python3 scripts/record_factory_event.py deploy production-finish render
```

If Render reports `build_failed`/`update_failed`, fetch the deploy logs (`GET /v1/services/$RENDER_SERVICE_ID/deploys/<id>` + the events/log API, or the Render dashboard) and treat it like any deploy failure above — fix, new PR, continue from Step 9.

### Step 2 — Functional health probe (liveness + DB/Prisma path)

```bash
python3 scripts/record_factory_event.py deploy production-start backend-probes
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
#     Cloud agents often inject SMOKE_BASE_URL=http://localhost:<port> — unset it
#     so the script's prod default wins (script also refuses localhost unless
#     SMOKE_ALLOW_LOCAL=1).
cd "$(git rev-parse --show-toplevel)/back-end" && \
  env -u SMOKE_BASE_URL -u SMOKE_HEALTH_URL -u SMOKE_FRONTEND_URL \
  npx tsx scripts/prod-endpoint-smoke.ts
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

After the endpoint checks and log scan are both green, close this lane:

```bash
python3 scripts/record_factory_event.py deploy production-finish backend-probes
```

**Migration-specific note:** if the error is a Prisma "column/table does not exist", the deployed code expects a schema the prod DB doesn't have. Verify the migration is both present in `back-end/prisma/migrations/` AND actually applied to prod (the migration row in `_prisma_migrations` can be marked applied while the column is absent if a stray `prisma db push` from another workspace dropped it — `back-end/.env` `DATABASE_URL` points at prod). Re-apply the missing DDL idempotently (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`) and re-run Step 2.

## Step 13ab: Verify cooperative generation cutover (handover monitor)

Skip only when `$AGENT_CUTOVER_REQUIRED` is `0`. Use the same immutable merged
source and workflow attempt selected in Step 13. CI already cut over only when
its durable job is `SUCCEEDED`; a green image build or an empty visibility query
is insufficient. The managed monitor --verify is authoritative for the saved
job, its exact pointer and retained bank evidence. Continue with the native
production checks below; this database report does not replace those checks.

```bash
DEPLOY_ROOT="$(git rev-parse --show-toplevel)"
if [ "$AGENT_CUTOVER_REQUIRED" = "1" ]; then
  if [ "${AGENT_DEPLOY_MODE:-cooperative}" = "existing-process" ]; then
    cd "$DEPLOY_ROOT/back-end"
    npx tsx scripts/deploy-existing-worker-processes.ts verify-live --execute \
      --plan "$WORKER_PROCESS_PLAN"
  else
    cd "$DEPLOY_ROOT/back-end" && source .env
    : "${AGENT_DEPLOYMENT_JOB_ID:?exact job from this workflow run required}"
    node --import tsx scripts/worker-deployment-queue.ts read \
      --job-id "$AGENT_DEPLOYMENT_JOB_ID" > /tmp/worker-deployment-verification.json
    node --input-type=module - /tmp/worker-deployment-verification.json \
      "$DEPLOY_MERGED_SHA" "$AGENT_DEPLOYMENT_TOKEN" <<'NODE'
import { readFileSync } from 'node:fs';
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (job.identity.sourceCommit !== process.argv[3] || job.identity.attempt !== process.argv[4])
  throw new Error('Job source or workflow attempt mismatch');
NODE
    node --import tsx scripts/monitor-cooperative-cutover.ts \
      --job-id "$AGENT_DEPLOYMENT_JOB_ID" --expected-hash "$AGENT_SURFACE_HASH" --verify
  fi
  python3 "$DEPLOY_ROOT/scripts/record_factory_event.py" deploy production-finish fly
fi
```

The normal path leases an existing idle bank, starts all eight candidates on a
new deployment queue, verifies them, and publishes the pointer with a database
lease and pointer compare-and-swap. It never allocates Machines or destroys a
bank. Every job gets a distinct queue, including same-code deployments. A
managed predecessor is stopped and returned to the pool only after durable
admission and exact native chain checks certify retirement. Long-running work
continues on its bank; expiry of the 45-minute observation window retains the
job and bank for another bounded observation rather than force-terminating it.

Legacy workers whose producer coverage is unknown remain served. Their
retention is an explicit first-deployment outcome, not a fabricated retirement
certificate. Sixteen enrolled Machines supply the two managed banks in addition
to the retained legacy cohort. The completed bank remains reserved as ACTIVE;
only its positively retired predecessor can become spare capacity again.

**First managed deployment:** keep automatic worker deployment disabled until
the complete managed producer/continuation protocol is live on Render, the
normal backend gates pass, and all old backend instances have drained. Bind this
proof to the exact producer commit and Render deployment. The existing maximum
shutdown window still applies:

```bash
RENDER_OLD_INSTANCE_DRAIN_SECONDS="${RENDER_OLD_INSTANCE_DRAIN_SECONDS:-375}"
case "$RENDER_OLD_INSTANCE_DRAIN_SECONDS" in ''|*[!0-9]*) exit 1;; esac
[ "$RENDER_OLD_INSTANCE_DRAIN_SECONDS" -ge 375 ] || exit 1
RENDER_DEPLOY_FINISHED_AT=$(curl -fsS -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/deploys?limit=20" | \
  PRODUCER_SHA="$DEPLOY_MERGED_SHA" python3 -c '
import json, os, sys
items = [x["deploy"] for x in json.load(sys.stdin)]
match = next((x for x in items if (x.get("commit") or {}).get("id") == os.environ["PRODUCER_SHA"] and x.get("status") == "live"), None)
if not match or not match.get("finishedAt"):
    raise SystemExit("Exact live producer deployment not found")
print(match["finishedAt"])
')
RENDER_DRAIN_REMAINING=$(RENDER_DEPLOY_FINISHED_AT="$RENDER_DEPLOY_FINISHED_AT" \
  RENDER_OLD_INSTANCE_DRAIN_SECONDS="$RENDER_OLD_INSTANCE_DRAIN_SECONDS" python3 -c '
from datetime import datetime, timezone
import math, os
finished = datetime.fromisoformat(os.environ["RENDER_DEPLOY_FINISHED_AT"].replace("Z", "+00:00"))
elapsed = (datetime.now(timezone.utc) - finished).total_seconds()
print(max(0, math.ceil(int(os.environ["RENDER_OLD_INSTANCE_DRAIN_SECONDS"]) - elapsed)))
')
while [ "$RENDER_DRAIN_REMAINING" -gt 0 ]; do
  sleep "$([ "$RENDER_DRAIN_REMAINING" -lt 10 ] && echo "$RENDER_DRAIN_REMAINING" || echo 10)"
  RENDER_DRAIN_REMAINING=$((RENDER_DRAIN_REMAINING - 10))
done
echo "Old Render instance/request drain window elapsed"
# Retain the exact native deployment, protocol response and functional gate receipts.
```

An HTTP sample from one new process does not prove that all old producers have
retired. Neither a queue name nor a zero workflow count can upgrade an UNKNOWN
legacy admission certificate. Preserve the first-deployment proof before
re-enabling automatic worker deployment.

An interrupted deployment resumes **the same job** using the queue CLI `run`
command and the original immutable image. Do not enqueue a replacement for a
partially prepared job, release its reservations on a timer, roll the pointer
back, or invoke forced workflow migration to make its status green. A queued job
with no preparation may be explicitly aborted under the shared lease. A failed
candidate that has never been published can be abandoned through the owned
controller; it first closes and certifies the unused target queue, then returns
only its unchanged reservations or stopped, verified candidates to the pool:

```bash
node --import tsx scripts/worker-deployment-queue.ts run \
  --job-id "$AGENT_DEPLOYMENT_JOB_ID" --allow-abort -- \
  python3 ../scripts/worker_pool_cutover.py --abort
```

This path refuses an ACTIVATED job or a changed/live target pointer. A failed
retirement check retains every reservation. Abandonment records `ABORTED`, never
changes the failed attempt to `SUCCEEDED`, and never destroys a Machine.
Scheduled recovery runs only the existing FIFO head; it does not rebuild an
image or enqueue another job. After a runner is interrupted, this observer
continues the saved job under a fresh global lease.

## Step 13ac: Validate workflow replacement edge cases in production

Skip only when `$AGENT_CUTOVER_REQUIRED` is `0`. Run this immediately after Step
13ab succeeds. This gate creates a uniquely named, isolated set of synthetic
stale workflows on a never-polled validation queue, replaces them onto the
production queue, and deletes every exact fixture ID afterward. The replacements
remain cold, so the gate makes no LLM/provider calls and does not spend model
credits.

The command must exit zero and print `PASS` for every row. It verifies paused,
cost-limited, and out-of-credits restoration; counters, context size, iteration
offset, duration origin, and historical configuration; approval-wait closure and
late approval rejection; exact-once terminalization of root and descendant
tools; success-before-seal and late-success races; descendant termination;
durable bootstrap acknowledgement; pause, resume, and cost-limit-update cutover
races; exact accounting and provider-attempt iteration deduplication; independent
cleanup of rapid workflow generations; zero activity growth while cold; clean
histories without patch markers or nondeterminism; malformed-root fail-closed
behavior; known-zombie absence; fleet convergence; and fixture cleanup.

```bash
if [ "$AGENT_CUTOVER_REQUIRED" = "1" ]; then
  cd "$(git rev-parse --show-toplevel)/back-end"
  PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1 \
    TEMPORAL_TASK_QUEUE=navi-agent-tasks \
    TEMPORAL_WORKER_BUILD_ID="$DEPLOY_MERGED_SHA" \
    TEMPORAL_WORKER_DEPLOYMENT_TOKEN="$AGENT_DEPLOYMENT_TOKEN" \
    npx tsx scripts/validate-prod-workflow-migration.ts --execute
fi
```

The matrix takes several minutes. Run it in the background and poll it; a
foreground tool timeout shorter than its runtime terminates it mid-matrix. The
script removes its own fixtures on SIGTERM/SIGINT, but an interrupted run proves
nothing and must be re-run.

Retain the JSON output as the production migration report card. Any failed row,
including fixture cleanup, blocks deploy completion and must be diagnosed and
fixed before Step 13b.

## Step 13w: Cloud WMH refresh + SIM smoke (skip unless WMH paths changed)

Run only when the merged diff touches the World Model Harness:

```bash
WMH_PATHS='agents/benchmarks/world_model_harness.py agents/benchmarks/experiential_bridge.py
agents/benchmarks/serve_world_model.py agents/benchmarks/build_experiential_world_model.py
agents/benchmarks/wmh_ agents/vendor/world-model/ agents/requirements-world-model.txt
scripts/setup-world-model.sh'
git diff --name-only "$DEPLOY_MERGED_SHA^1" "$DEPLOY_MERGED_SHA" | grep -F -f <(tr ' ' '\n' <<<"$WMH_PATHS" | grep .)
```

Cloud SIM guests sync the run's ref, so serving-code changes reach them
without a rebuild. Rebuild the cached model only when the build, vendored
simulator or `requirements-world-model.txt` changed (guests refuse a stale
native venv):

1. `bash scripts/run-bench-cloud --build-wmh` (big owned machine; publishes
   the `rose-archive-serving` R2 cache).
2. `bash scripts/run-bench-cloud --refresh-wmh` (donor restores that cache and
   the native venv, then snapshots).

Always prove the merged WMH on the cloud with the unchanged task, then follow
the `/benchmark` monitoring contract through resource release:

```bash
scripts/run-bench raise-5m-rose-labs-brex --sim-on raise-5m-rose-labs-brex
```

Pass = the guest serves the native model (`engine=experiential` in the run's
execution provenance, WMH `/healthz` ready) and the task reaches a terminal
verdict with simulated tool calls answered by the WMH. A WMH serve, guard or
provisioning failure blocks completion: RCA and fix it, then rerun. A genuine
task FAIL is reported, not retried into a pass.

## Step 13b: Production semantic frontend gate (no skip — always runs)

After the changed runtime surfaces exercised by semantics are live (Fly,
Render, and/or Vercel) and Step 13a is green when applicable, dispatch the
trusted production semantic workflow. Do not wait for the independent Mac release lane;
keep it running concurrently. This runs every frontend semantic
spec in one job with four Playwright workers and one shared authenticated
session. It includes the four-path, five-sample, full-lifecycle chat ratchet.

```bash
# The boxes.dev gh wrapper replaces GH_TOKEN with an App token that cannot
# dispatch workflows; call its binary with the repo's workflow-scoped token.
if [ -x /opt/devbox-tools/gh/current/bin/gh ]; then
  GH_TOKEN=$(set -a && . back-end/.env >/dev/null && printf %s "$GITHUB_TOKEN")
  export GH_TOKEN
  gh() { /opt/devbox-tools/gh/current/bin/gh "$@"; }
fi
python3 scripts/record_factory_event.py deploy production-start semantic
SEMANTIC_DISPATCH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run chat-lifecycle-ratchet.yml --ref main \
  -f frontend_url=https://www.roselabs.ai \
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
python3 scripts/record_factory_event.py deploy production-finish semantic
```

This is a hard deployment gate. If the workflow fails, the deployment is not complete: inspect its Playwright artifacts and service logs. For a provider outage, follow "Provider outages: report and retry every 10 minutes" above; use `gh run rerun "$SEMANTIC_RUN_ID" --failed` once the prior attempt is terminal so only failed jobs are retried. Retain successful jobs under their original execution provenance and audit the retry's actual checkout SHA and results. For a code defect, fix the root cause in a new PR and repeat the deploy loop. Do not report success or proceed to Step 14 while this check is red.

If no workflow-scoped token is available, `gh workflow run` returns HTTP 403
`Resource not accessible by integration`. In that case, run the workflow's two
steps locally against production with the same secrets from `back-end/.env`.
Report the lane as `run locally` under SHIPPED WITH:

```bash
set -a && . back-end/.env && set +a
export TEST_API_KEY="$BACKEND_API_KEY" BACKEND_URL=https://navi-j9a9.onrender.com \
  FRONTEND_URL=https://www.roselabs.ai
SEMANTIC_GREP_INVERT="chat full-lifecycle latency" SEMANTIC_WORKERS=4 \
  bash front-end/scripts/run-semantic-tests.sh --prod
SEMANTIC_WORKERS=1 bash front-end/scripts/run-semantic-tests.sh --prod chat-lifecycle-latency
```

## Step 13c: AgentCard production lifecycle gate

Skip when `$CHANGED_AGENTCARD_PAYMENT` is empty. The standing release-stall
exception in Step 6a also applies to this production gate automatically and
without further approval. Run after both the backend
and frontend merged commits are live. Launch it concurrently with the semantic
gate because the two checks are isolated:

```bash
python3 scripts/record_factory_event.py deploy production-start agentcard
cd "$(git rev-parse --show-toplevel)" && source agents/venv/bin/activate
scripts/run-bench agent-payment-production-abandonment
python3 scripts/record_factory_event.py deploy production-finish agentcard
```

**Prod payment identity (prerequisite).** These tasks run as the NON-admin
`BENCHMARK_PAYMENT_LIFECYCLE_PROD_USER_ID` (`...000107`), because the admin path
(`issueAdminCompanyCard`) never authorizes a personal Stripe hold and the task asserts
`stripeHold: succeeded`. Every credential needed is already in `back-end/.env` — do NOT ask
the user for them. If the run fails closed on a missing identity, provision it:

```bash
cd back-end && set -a && . ./.env && set +a && \
  DATABASE_URL="$DIRECT_URL" STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY_LIVE" \
  BENCHMARK_ALLOW_LIVE_STRIPE=1 BENCHMARK_PAYMENT_ALLOW_REMOTE_DB=1 \
  npx tsx scripts/setup-benchmark-payment.ts --live --user-id 00000000-0000-4000-8000-000000000107 \
  --agentcard-cardholder-id "$DEDICATED_AGENTCARD_CARDHOLDER_ID"
```

Use `npx tsx scripts/setup-benchmark-payment.ts --help` for the effect-free CLI reference.
Choose an **existing dedicated** benchmark cardholder; never select Andy's or another actor's
cardholder, create an identity automatically, or bypass pending KYC. `--agentcard-cardholder-id`
binds that exact ID after environment fallback resolution. Live setup prefers the complete local
`AGENTCARD_ORG_OAUTH_CLIENT_ID_LIVE` / `AGENTCARD_ORG_OAUTH_CLIENT_SECRET_LIVE` pair process-locally;
an incomplete pair fails before any provider or DB call. If both are absent, the existing generic
production pair remains supported. No global env file or Stripe billing key is changed.
`--stripe-customer-id` can reuse an existing owned live fixture customer; ownership, live-wallet,
and KYC checks still apply. Existing purchase history is preserved.

Use `DIRECT_URL`; the 6543 pooler fails with `Can't reach database server`. The only step an
agent cannot perform is saving a card on the live Stripe customer (entering a card number is
prohibited) — the script prints a one-time hosted Checkout link for a human, and it persists
permanently once done.

This production-only task reserves exactly $1.00 from the existing AgentCard organization float, captures the matching live Stripe payment, issues a live AgentCard, and deliberately leaves merchant checkout unsubmitted. The benchmark must then close the card, observe the organization transfer as `reclaimed` with `livemode=true`, refund the Stripe capture, and report no open payment attention request.

The runner performs the abandon/reclaim/refund action idempotently on success,
failure, cancellation, and verifier errors before deleting the benchmark agent.
A fully observed closed-card / consumed-transfer / zero-release stall is
`⚠️⚠️ SKIPPED` under the permanent user-approved exception, and does not block
deploy completion. Record its still-unreleased allocation and pending refund;
never claim cleanup passed. A missing snapshot or any other failure still blocks.
Existing failed attempts remain unchanged: record their deploy gate as explicitly
waived when their saved native evidence proves this same stall. Do not allocate
another live card or require a human-saved live Stripe card merely to replace
that waived result. If the process was forcibly killed, recover the printed
agent's execution/browser resources before assessing the financial exception.

After every applicable production deployment, health, semantic, release, and
AgentCard gate has passed or has this explicitly permitted warning skip, close
the production-verification lifecycle:

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
python3 scripts/factory_ledger.py publish
```

`publish` appends this deploy's stage records, review, production and outcome
events to `main`'s `agents/benchmarks/history/factory_events.jsonl` (see the
publication rule before Step 0i). `/factory-review` then rebuilds /deploy and /RCA
timing from the repo on any machine.

After the new branch is created, the final message is only this scorecard in a
`text` block, with no prose before or after it. Fill every value from recorded
evidence:

- Lane times come from `.context/deploy-runs/<run-id>/stages.jsonl`: sum every
  attempt of the lane (passed, failed, interrupted) and show the run count and
  failure causes. Production lane times come from `.context/factory-events.jsonl`
  and also cover every attempt. Parallel lanes overlap.
- `⏱` is the total from `metadata.json` `started_at` to the `deploy outcome` event,
  broken down so it adds up: active gate/review/prod time (union of intervals) +
  each blocked window + other time (investigation, fixes, waiting on the user).
- `💸` is the summed benchmark `cost_cents` of this deploy's runs.

Lane marks:

- `✅` means the lane ran and passed.
- `❌` means failed.
- `⚠️` is reserved for a required check that was skipped, with the reason.
- Omit lanes that did not apply, except TEMPORAL, which is always shown.

TEMPORAL reports Step 13–13ab:

- After a cutover: old → new generation, workflows drained, and force-migrated
  count.
- Otherwise: `no cutover needed` and the live pointer generation, read with
  Step 13's queue-pointer `--read` query.

SHIPPED WITH has one `▲` row per warning, override, skip, substitution, or
unreviewed commit. Each row shows the wall time it wasted: stopped, failed or
superseded attempts, review cycles that produced no review, retries, and detours
around it. Use `0s` when it cost nothing, add a total row, or write `▲ none`.

NOT SHIPPED has one `✖` row per piece of this workspace's work that is absent
from `origin/main` after the merge, each with a concise explanation of what the
change is and why it was not included:

- Non-ignored uncommitted or untracked changes.
- Reverted or unmerged commits on branches this workspace created or pushed.

Ignore other workspaces' branches. Write `✖ none` if there is nothing.

End with a `READY TO CLOSE` line: `✅` when nothing is left open; `⚠️` plus the
open items when work remains outside the merge (unsettled prod state, unshipped
rows, follow-ups); `❌` when the deploy is not complete.

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 🚀 DEPLOY SCORECARD                                  ✅ SHIPPED
 #1456 · bounded Hub index repair · 014727c → main
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 STATIC     ✅  lint · tsc · structural · 45 gates            4m55s
 COVERAGE   ✅  BE 190/190 domains · 89.2% lines             11m10s
 LIVE       ✅  creds 6/7 · amplitude · failover · seed 156MB  2m15s
 SMOKE      ✅  8/8 benches                                  18m14s
 SEMANTIC   ✅  8/8 UI · latency p50 0.7–1.9s                10m06s
 SANDBOX    ✅  Claude Code E2B 56/56                           37s
 REVIEW     ⚠️  3 cycles · 1 fixed · last skipped (quota)    12m14s
────────────────────────────────────────────────────────────────
 PROD       ✅  Render live · 14/14 probes · 0 log errors     6m23s
            ✅  semantic 6/6 · AgentCard $1 → refunded       11m14s
 TEMPORAL   ✅  no cutover needed · gen 7d9946f524be live
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ⏱ <total> = <active> active + <blocked> blocked + <other> other
 💸 $1.68 LLM   🌿 fix/hub-index-repair-bounded-2
 🔗 github.com/Rose-Ai-Labs/rose/pull/1456
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ▲ SHIPPED WITH                                          ⌛ wasted
 ▲ last review cycle skipped · CodeRabbit + Claude quota      4m17s
 ▲ history-ledger revert · GitHub merge conflict              2m27s
 ▲ Anthropic API credits exhausted · warn-only                   0s
 ▲ prod semantic run locally · GH token can't dispatch           0s
                                                    total     6m44s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ✖ NOT SHIPPED · this workspace
 ✖ 150ba48a0  smoke history: 30 ledger rows + 10,479 spans · reverted
   because GitHub flagged a ledger merge conflict
 ✖ worktree   prod AgentCard history rows · uncommitted; landing them
   would have changed HEAD after review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 READY TO CLOSE  ✅  nothing left open
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

That example is the PR #1456 deploy. Keep the layout and replace every value. For
a deploy that stops early, the header reads `❌ BLOCKED · <lane> <result>`, the
failing lane is listed first, and lanes that never ran are omitted.


### Required post-deploy: cloud-origin local Mac execution and computer use

This is an explicit user acceptance gate. Keep it **OPEN** until witnessed on an
owned connected Mac; offline relay tests or a tool acknowledgement are insufficient.
Do not start a new database, migrate production, replace encryption keys, or reset
sign-in/app data to satisfy it. Preserve Freedom and all its blocking services.

1. Start a WEB/cloud-origin Rose root using the deployed revision. Explicitly call
   `spawn_agent(type="code", target="local", ...)`. Resolve the intended owned Mac:
   one registered Mac may resolve automatically; multiple Macs require explicit
   selection. Preserve that device ID through recorded target resolution, session
   creation, reconnect and replay. Never fall back to E2B or another device.
2. Record root/child/task/device IDs (no credentials), the granted project folder,
   `uname -s` = `Darwin`, actual working directory and checked-out revision. Verify
   commands travel through the authenticated local relay to this same Mac.
3. Exercise a harmless local computer-use action through the supported relay and
   verify its visible effect on that Mac. Record the actual transport, permission
   state and evidence. Terminal command success alone does not pass computer use;
   absent screen/control support or missing macOS consent is a precise blocker.
4. Build the current Rose native Mac app in the granted existing checkout using
   its existing production backend/auth configuration and authoritative Mac setup
   instructions. Retain the user's existing keys, credentials, account, app data
   and database. Capture build command, exit status and native artifact path/hash;
   launch/verify that artifact against the intended production account.
5. Record disconnect, denied-folder and foreign-device rejection; no session or
   cloud fallback may be created. Close only the test-owned session and preserve
   the Mac app, granted files, data, user services and Freedom.

Owner: Code Main. Missing connected Mac/access/consent keeps this acceptance OPEN;
report that prerequisite instead of marking a mocked or Linux-only run successful.
