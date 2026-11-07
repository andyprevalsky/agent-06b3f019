---
description: "Ship the whole devbox to production: gates, review, merge, production verification, scorecard."
rose-agent-spawn: false
---

# /deploy

Ship every intended Rose change on this devbox to production, verified, and publish the deploy scorecard.
Run every command from the repo root; `scripts/deploy --help` lists the steps.

## Done

The PR is merged, every applicable production lane is verified or has a recorded exception, the worktree is deletion-ready, and the scorecard is published as the last message to the user.

## Process

| # | Step | Command |
|---|------|---------|
| 1 | Sync with the latest main: fetch it and merge it into this branch before anything else | `scripts/deploy sync` |
| 2 | Check an isolated deploy worktree (no-op in the canonical checkout) | `bash scripts/prepare-deploy-worktree.sh --check` |
| 3 | Inventory every worktree and branch, read sibling threads, integrate their deliverables | `scripts/deploy collect` |
| 4 | Start the timing run | `bash scripts/run-deploy-stage --start` |
| 5 | Format and lint-fix, commit everything, run the approval guards | `scripts/deploy freeze -m "<message>"` |
| 6 | Push, open the PR, start review cycle 1 | `scripts/deploy open-pr --title "<title>" --body-file <file>` |
| 7 | Run every selected gate in parallel, in the background: one Blacksmith GitHub Actions VM per gate; smoke, AgentCard tasks included, on the Fly fleet (`--executor local` runs the other gates on this box) | `scripts/deploy gates` |
| 8 | Wait for the review on the exact HEAD, in the background beside step 7 | `scripts/deploy review-wait` |
| 9 | Close the review cycle | `scripts/deploy review-finish --result clean\|findings` |
| 10 | Commit this deploy's benchmark history rows before the final review cycle | `scripts/deploy ledger` |
| 11 | Push the stabilization batch and open review cycle 2 or 3, then repeat 7–9 | `scripts/deploy review-next` |
| 12 | Prove gates, review, ledger and approvals pass, then merge | `scripts/deploy merge` |
| 13 | Dispatch post-merge repairs, then confirm none are pending | `python3 scripts/deploy_test_cycle.py complete --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline` |
| 14 | Verify every applicable production lane | `scripts/deploy production` |
| 15 | Close the timing run, record the outcome, publish telemetry | `scripts/deploy finish` |
| 16 | Prepare the scorecard, then prove deletion readiness | `scripts/deploy deletion-check --manifest <manifest.json>` |
| 17 | Send the scorecard as the last message | see **Scorecard** |

## Guidelines

### Scope

- Ship the whole devbox: every committed, staged, unstaged and untracked non-ignored change relative to `origin/main`, from every thread.
- Never ask whether a change is yours; whoever runs `/deploy` owns everything in the worktree.
- Use one deploy coordinator per devbox; a second `/deploy` joins it instead of competing.
- A historical branch or test copy is not a deliverable unless its owner's handoff says so.
- Never commit secrets, ignored `.env` files, caches, dependencies, research data or generated evidence.
- Sync with main once, first (`scripts/deploy sync`), and never during the run; a merge conflict reported by `scripts/deploy merge` forces another sync, then rerun the affected gates.
- Resolve sync conflicts keeping all of main's code and the branch's intent; never discard main's side.

### Execution

- Keep going until **Done** or a **Stopping condition**; a blocking result is work to resolve, not a reason to pause.
- Run independent work in parallel; serialize only real conflicts on a checkout, database, resource or production cutover.
- Run `gates` and `review-wait` in the background and watch both; start `/RCA` on each failure as soon as it appears, not when `gates` exits.
- Never fire and forget: every background command has an owner that watches it until exit and cleanup.
- Every lane owns its own setup, cleanup and teardown; never kill processes you did not start.
- A Blacksmith gate's result and logs come back over the R2 result channel (and its GitHub Actions artifact); RCA reads the local copies in that gate's evidence and its run URL.
- "Pre-existing", "flaky", "resource contention", "doesn't touch agent code" and "agents timing out" are never evidence for an exception or attribution.
- Never change assertions, timeouts, concurrency, task definitions or coverage thresholds to get green.
- Never disable a linter or type checker.
- Never merge an unwaived blocking failure, and never invent a PASS.
- A skip, waiver, exception or override is never PASS; keep the native result visible.
- An override must name the gate explicitly; never infer one, never re-confirm it, keep it narrow, and list its risk in the PR.
- On any stop, run `scripts/deploy finish --outcome blocked` before ending the turn.

### Approvals

- `scripts/deploy fix` runs the same formatters and lint fixes without committing.
- Classify every hunk `freeze` flags: code-only hunks pass without review; text an LLM reads, including text built at runtime, is a prompt.
- Run one golden-reference review over the remaining hunks; a `GROUNDED` verdict clears them: `scripts/deploy approval decide --decision grounded --evidence "<reviewer id>"`.
- Otherwise run `scripts/deploy approval request` and send one packet in `.claude/shared/approval-format.md` format, pasting the exact diff inline.
- Send the packet as the turn's last message only after gates run in the background, under a bounded keep-awake cancelled by its `holdId`.
- Never infer approval from silence or earlier discussion; record the answer with `scripts/deploy approval decide --decision approved|rejected --evidence "<user message>"`.
- A rejection stays blocked; a re-request from `approval decide` or `merge` means re-freeze and send a packet for only the changed files.
- Approvals are snapshot-scoped: a later change to an approval-scoped hunk needs a new approval.
- Deploy-tooling edits to this file (test selection, gate wiring, evidence) are operational, not prompt changes.

### AgentCard

- The sandbox lifecycle tasks are ordinary smoke tasks on the fleet; there is no separate AgentCard gate or election.
- After a confirmed release stall, stop retrying: never mint another card, keep reclaiming, or ask the user again.
- A failed AgentCard task finishes its payment lifecycle cleanup on its own guest before the fleet releases it.
- If a production AgentCard run is force-killed, recover its agent's execution and browser resources before judging the financial exception.

### Production

- Bind every production check to the exact merge commit, never to the latest `main`.
- An interrupted Fly cutover resumes the same job; never enqueue a replacement, release reservations on a timer, roll the pointer back or force-migrate workflows.
- Keep automatic worker deploys off for the first managed deployment until the Render protocol is live and old instances have drained for at least 375 s.
- On a production "column does not exist" error, compare `_prisma_migrations` with the real schema and re-apply the missing DDL idempotently.
- When migration preflight fails, fix the migration (batched backfill, repaired rows); use its allow directive only for a measured, reasoned risk.
- Never change production auth to make a rejected credential look healthy, and never work around auth errors in code.

### Mac local acceptance

- Never migrate production, start a new database, replace encryption keys, or reset sign-in or app data.
- Bind the intended device ID with no E2B or other-device fallback, and record the IDs, `Darwin` and the revision.
- Prove disconnect, denied-folder and foreign-device rejection; the acceptance stays OPEN until witnessed on that Mac.

### Benchmarks and cleanup

- Smoke runs on the cloud fleet through the benchmark CLI; follow `/benchmark` monitoring through resource release.
- Paid cloud smoke waits for the `cloudbench-controller` gate when that gate is selected; every other gate runs unordered.
- Larger paid fleet campaigns stay human-requested and are never added to the automatic deploy.
- A lane teardown that ends `killed` or `failed` needs `scripts/run-bench --local --run-id <run> --reconcile-cleanup` before the next local benchmark lane.
- Never move a benchmark run directory by hand while a process still carries its run id.
- Tear stacks down with `scripts/kill-services.sh`; `scripts/teardown.sh` destroys the database container and volume.
- Treasury skips never reclaim or delete records, and never hide pending or overdue obligations.

### Review and PR

- A human GitHub review is not required; CodeRabbit is the only review gate.
- Keep a per-step test report (step, status, summary) and put it in the commit message and PR body.
- The PR body lists every override with its risk and the user's approval, every `GROUNDED` line, and "merged unreviewed" after a quota skip.
- Never push while a review cycle is open; batch every review and gate fix and push once with `review-next`.
- Never push an unreviewed commit before merge.
- Move the related `docs/plans/active/` plan to `docs/plans/completed/` in the stabilization batch before the final review cycle.

### Preservation and reporting

- Preserve every needed local record (commit it, or archive it privately and commit its manifest) before `deletion-check`.
- Records created after merge go in a reviewed records-only follow-up PR on main, linked from the deployed PR, before the scorecard.
- `deletion-check` writes `docs/handoffs/pr-<N>-closeout/deletion-readiness.json`; commit it in that follow-up PR and rerun until it reports READY.
- SHIPPED certifies deletion readiness; any unresolved preservation keeps the deploy incomplete and listed in FOLLOWUPS.
- Never delete the local or remote branch.
- Preserve Freedom and protected instructions.

## Stopping conditions

Stop and ask the user only for a prompt, agent-behavior or trajectory-injection approval the golden-reference review did not clear; gates keep running, only the merge waits.

Two more decisions stay with the user, though this skill adds no stop of its own: the verification-cycle approval id (the review ledger will not start that cycle without it), and a security or prod-impacting finding still open after cycle 3 (the user's answer of 2026-11-05; the ledger refuses a 4th cycle). See **Review**.

Stop immediately when the user says stop. Credential or billing changes only the user can make, provider credit exhaustion, review cycles, owner labels, monitoring deadlines, review-quota exhaustion, provider outages and failed rounds are never stops.

## Skippable tests

Everything not listed here must pass. Record every skip as `⚠️ Skipped` with its evidence and list it in the scorecard.

| Test | Skip when | Note |
|------|-----------|------|
| Any test | A third-party provider is out of credits or storage, is down, or needs a credential or billing change only the user can make (user decision, 2026-11-06: skip and report), with explicit evidence; record it as an external-provider waiver (`credits exhausted`, `outage` or `credential or billing change`) | Never top up or wait; report it at the end of the scorecard |
| Treasury test failures | Always (the test still runs; its original FAIL stays on record) | Never mutate treasury records to pass |
| AgentCard, production lane | The user elects it (`--skip-agentcard "<reason>"` on `scripts/deploy production`), or the exact release stall | The stall proven from the run's native record is recorded `SKIPPED-stall` (satisfied, never PASS, unreleased amount stated); any other outcome fails |
| AgentCard, smoke tasks | The exact release stall (closed card, zero balance, transfer `consumed`, `releasedCents=0`) | Triage the native SKIPPED row as `resource_skip` with `reason_code: agentcard_release_stall`; never PASS; unreleased funds stay a followup |
| Claude Code smoke | Preflight proves no synced Claude credential and no pool token | Task failures still block |
| Codex E2B smoke | Every Codex credential path is out of credits (the test skips itself) | Never use `BLACKBOX_TEST_SKIP_DOMAINS` |
| Benchmark judge | Confirmed third-party compute quota | |
| Credential health: Anthropic, Parallel.ai | Any failure (warn-only) | Other providers' auth rejections block |
| CodeRabbit | Confirmed quota or spending cap on the current HEAD: `deploy_review_cycle.py skip --reason usage-cap` | The PR body says it merged unreviewed |
| Mac-only checks on Linux | Always | Unverified, never PASS |
| Mac local-execution acceptance | Device discovery shows no connected Mac | An auth error is not proof of absence |
| Unselected categories | The gate planner omitted them | The plan lists every omission |
| Any gate | The user explicitly overrides that named gate | Record `⚠️ Overridden` |

Never skip for an unexplained failure, an auth failure our own configuration caused, local disk exhaustion, or an outage without evidence.

## When a gate fails: triage and parallelize

1. Keep every healthy lane running; never cancel siblings.
2. Start one `/RCA` sub-agent per independent failure as soon as it arrives.
3. Each RCA returns an evidence-backed `Gate: INTRODUCED` or `Gate: NOT_INTRODUCED`; without evidence it is UNKNOWN.
4. INTRODUCED: fix it in this deploy. UNKNOWN: blocking until attributed.
5. NOT_INTRODUCED: keep the failed-test packet; it does not block the merge and is handed off after merge.
6. Provider outage or exhausted credits with evidence: external exception, no handoff, alert at the end of the scorecard; likewise a credential or billing change only the user can make.
7. An assigned repair (the failure your `/goal` targets) stays yours whatever the attribution says.
8. Import the attributions: `python3 scripts/deploy_test_cycle.py triage --input report.json`.
9. After a fix: `focus --input focused.json` then `run` (failing tests plus regressions), then the full failed gates, then every selected gate on the final source.
10. A failure in the final sweep goes back to step 2; a focused pass is never a deploy pass.
11. Never rerun blind: the staged runner requests `/RCA` on the first failure of every round, so each rerun follows a repro, a fix and its regression.
12. After merge, dispatch each NOT_INTRODUCED packet as a `/goal` on a new devbox in the Bugs folder at high effort and standard speed.

Details: `.claude/shared/deploy-failure-policy.md` and `docs/deploy-test-cycle.md`.

## Review

- Cycle 1 starts when the PR opens; cycle 2 is one batched incremental review; cycle 3 only when cycle 2 found a valid issue; the ledger refuses a 4th.
- After a clean cycle 2, gate fixes that changed source need a verification cycle, which the ledger only starts with the user's explicit approval id (`scripts/deploy review-next --verification-approval <id>`); batch every source fix into cycle 2 where possible, and ask for the id in the same message as any other pending question.
- Read the reviews for the exact HEAD from the reviews, inline comments and issue comments endpoints; a green check is not a review.
- Fix every valid finding, including pre-existing ones; ignore only pure style nits.
- Reply to every comment with `[FIXED]`, `[DEFERRED]`, `[IGNORED]`, `[DELEGATED]` or `[POST-MERGE REPAIR]`; `override` requires `[DEFERRED]` or `[FIXED]` on each deferred finding.
- If cycle 3 still has valid findings, defer the non-security ones with `deploy_review_cycle.py override` and merge; fix security or prod-impacting ones, then ask the user how the fix is reviewed (the ledger refuses a 4th cycle).
- A false-green or bot-posted request gets one `@coderabbitai full review` from the user's account.
- Over 150 files: add the canonical path filters in a later stabilized commit; never weaken the review.
- Main moved after a clean final review: `deploy_review_cycle.py inherit-sync --head "$(git rev-parse HEAD)" --base origin/main`.
- The Claude fallback review is disabled.

## Production lanes

`scripts/deploy production` reads the files changed by the merge commit and runs every applicable lane concurrently; `--dry-run` shows the plan.

| Lane | When |
|------|------|
| Render live on the merged SHA, then endpoint probes and log scan | `back-end/` changed |
| Fly worker cutover, then the workflow migration matrix | agent runtime or `deploy-agents.yml` changed |
| Vercel live on the merged SHA | `front-end/` changed |
| Production semantics | always, after the Render, Vercel and Fly lanes it exercises |
| AgentCard production lifecycle (PASS, `SKIPPED-elected`, or `SKIPPED-stall` for the exact release stall) | AgentCard or payment paths changed |
| WMH SIM smoke | World Model Harness paths changed |
| Mac release | `scripts/mac-app-release-decision` ships (shipped Mac surface changed, or the `MAC-APP-RELEASE` label) |
| Mac local execution + computer use (manual) | a connected Mac exists: cloud-origin `spawn_agent(type="code", target="local")`, one visible computer-use action, native app build |

A failed lane goes through **When a gate fails**; a code fix ships as a new PR through the whole process.

## Scorecard

Publish the `deploy-summary-v2` card from `.claude/shared/report-display-format.md` using `.claude/shared/deploy-scorecard-template.html`, following the scorecard freshness rule in `.claude/shared/deploy-failure-policy.md`.

## References

- Failure ownership, handoffs, provider exceptions: `.claude/shared/deploy-failure-policy.md`
- Staged gate runner: `docs/deploy-test-cycle.md`
- Approval packets and golden-reference review: `.claude/shared/approval-format.md`
- Scorecard layout and display rules: `.claude/shared/report-display-format.md`
- Preservation prior art: `docs/handoffs/pr-1634-closeout/`
- Factory telemetry metadata: `docs/factory-telemetry.md`
- Existing-Machine worker deployment mode: `docs/existing-worker-process-deployment.md`
