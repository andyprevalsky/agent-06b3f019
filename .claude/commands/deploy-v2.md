---
description: "Ship the whole devbox to production: gates, review, merge, production verification, scorecard."
rose-agent-spawn: false
---

# /deploy

Ship every intended Rose change on this devbox to production, verified, and publish the deploy scorecard.
Run every command from the repo root; `scripts/deploy --help` lists the steps.

## Done

The PR is merged, every applicable production lane is verified or has a recorded exception, the worktree is deletion-ready, and the scorecard is published.

## Process

| # | Step | Command |
|---|------|---------|
| 1 | Check an isolated deploy worktree (no-op in the canonical checkout) | `bash scripts/prepare-deploy-worktree.sh --check` |
| 2 | Inventory every worktree and branch, read sibling threads, integrate their deliverables | `scripts/deploy collect` |
| 3 | Start the timing run | `bash scripts/run-deploy-stage --start` |
| 4 | Format and lint-fix, commit everything, run the approval guards | `scripts/deploy freeze -m "<message>"` |
| 5 | Push, open the PR, start review cycle 1 | `scripts/deploy open-pr --title "<title>" --body-file <file>` |
| 6 | Run every selected gate in parallel and verify them | `scripts/deploy gates` |
| 7 | Wait for the review on the exact HEAD | `scripts/deploy review-wait` |
| 8 | Prove gates, review and approvals pass, then merge | `scripts/deploy merge` |
| 9 | Dispatch post-merge repairs, then confirm none are pending | `python3 scripts/deploy_test_cycle.py complete --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline` |
| 10 | Verify every applicable production lane | `scripts/deploy production` |
| 11 | Prove deletion readiness | `scripts/deploy deletion-check --manifest <manifest.json>` |
| 12 | Close the timing run, publish ledger rows, record the outcome, publish telemetry | `scripts/deploy finish` |
| 13 | Publish the scorecard | see **Scorecard** |

## Guidelines

- Ship the whole devbox: every committed, staged, unstaged and untracked non-ignored change relative to `origin/main`, from every thread.
- Never ask whether a change is yours; whoever runs `/deploy` owns everything in the worktree.
- Use one deploy coordinator per devbox; a second `/deploy` joins it instead of competing.
- A historical branch or test copy is not a deliverable unless its owner's handoff says so.
- Never commit secrets, ignored `.env` files, caches, dependencies, research data or generated evidence.
- Never sync with main during a deploy; GitHub merges the PR. Only a merge conflict reported by `scripts/deploy merge` forces `/sync`, then rerun the affected gates.
- Keep going until **Done** or a **Stopping condition**; a blocking result is work to resolve, not a reason to pause.
- Run independent work in parallel; serialize only real conflicts on a checkout, database, resource or production cutover.
- Never fire and forget: every background command has an owner that watches it until exit and cleanup.
- Every lane owns its own setup, cleanup and teardown; never kill processes you did not start.
- Smoke runs on the cloud fleet through the benchmark CLI; follow `/benchmark` monitoring through resource release.
- Never push while a review cycle is open; batch every fix and push once.
- Never push an unreviewed commit before merge.
- Never merge an unwaived blocking failure, and never invent a PASS.
- A skip, waiver, exception or override is never PASS; keep the native result visible.
- Never change assertions, timeouts, concurrency, task definitions or coverage thresholds to get green.
- Never disable a linter or type checker.
- A human GitHub review is not required; CodeRabbit is the only review gate.
- `scripts/deploy fix` runs the same formatters and lint fixes without committing.
- When `freeze` flags approval hunks, run one golden-reference review and record it with `deploy_approval_batch.py decide`.
- A `GROUNDED` review clears the prompt, agent-behavior and trajectory-injection guards; otherwise send one approval packet.
- Approval packets follow `.claude/shared/approval-format.md` and paste the exact diff inline.
- Approvals are snapshot-scoped: a later change to an approval-scoped hunk needs a new approval.
- Deploy-tooling edits to this file (test selection, gate wiring, evidence) are operational, not prompt changes.
- Bind every production check to the exact merge commit, never to the latest `main`.
- Preserve every needed local record (commit it, or archive it privately and commit its manifest) before `deletion-check`.
- Never delete the local or remote branch.
- Preserve Freedom and protected instructions.

## Stopping conditions

Stop and ask the user only for:

1. A prompt, agent-behavior or trajectory-injection approval the golden-reference review did not clear; gates keep running, only the merge waits.
2. A credential or billing change only the user can make that is not a qualified external exception.
3. A request for an explicit gate override.
4. A destructive or irreversible action that needs approval.
5. A failure that cannot be fixed without the user.

Stop immediately when the user says stop. Review cycles, owner labels, monitoring deadlines, review-quota exhaustion, provider outages and failed rounds are never stops.

## Skippable tests

Everything not listed here must pass. Record every skip as `⚠️ Skipped` with its evidence and list it in the scorecard.

| Test | Skip when | Note |
|------|-----------|------|
| Any test | A third-party provider is out of credits or storage, with explicit evidence | Never top up or wait |
| Treasury tests | Always | Never mutate treasury records to pass |
| AgentCard lifecycle, local or production | The user elects it (`--skip-agentcard "<reason>"` on `scripts/deploy gates` or `scripts/deploy production`), or the exact release stall: closed card, zero balance, transfer `consumed`, `releasedCents=0` | Unreleased funds stay a followup |
| Claude Code smoke | Preflight proves no synced Claude credential and no pool token | Task failures still block |
| Codex E2B smoke | Every Codex credential path is out of credits (the test skips itself) | Never use `BLACKBOX_TEST_SKIP_DOMAINS` |
| Benchmark judge | Confirmed third-party compute quota | |
| Credential health: Anthropic, Parallel.ai | Any failure (warn-only) | Other providers' auth rejections block |
| CodeRabbit | Confirmed quota or spending cap on the current HEAD: `deploy_review_cycle.py skip --reason usage-cap` | The PR body says it merged unreviewed |
| Mac-only checks on Linux | Always | Unverified, never PASS |
| Mac local-execution acceptance | Device discovery shows no connected Mac | An auth error is not proof of absence |
| Unselected categories | The gate planner omitted them | The plan lists every omission |
| Any gate | The user explicitly overrides that named gate | Record `⚠️ Overridden` |

Never skip for an unexplained failure, an auth rejection outside the warn-only row, local disk exhaustion, or an outage without evidence.

## When a gate fails: triage and parallelize

1. Keep every healthy lane running; never cancel siblings.
2. Start one `/RCA` sub-agent per independent failure as soon as it arrives.
3. Each RCA returns an evidence-backed `Gate: INTRODUCED` or `Gate: NOT_INTRODUCED`; without evidence it is UNKNOWN.
4. INTRODUCED: fix it in this deploy. UNKNOWN: blocking until attributed.
5. NOT_INTRODUCED: keep the failed-test packet; it does not block the merge and is handed off after merge.
6. Provider outage or exhausted credits with evidence: external exception, no handoff, alert at the end of the scorecard.
7. An assigned repair (the failure your `/goal` targets) stays yours whatever the attribution says.
8. Import the attributions: `python3 scripts/deploy_test_cycle.py triage --input report.json`.
9. After a fix: `focus --input focused.json` then `run` (failing tests plus regressions), then the full failed gates, then every selected gate on the final source.
10. A failure in the final sweep goes back to step 2; a focused pass is never a deploy pass.
11. After two failed rounds the runner refuses a blind rerun; resume only with `run --after-rca "<rca ref>"`.
12. After merge, dispatch each NOT_INTRODUCED packet as a `/goal` on a new devbox in the Bugs folder at high effort and standard speed.

Details: `.claude/shared/deploy-failure-policy.md` and `docs/deploy-test-cycle.md`.

## Review

- Cycle 1 starts when the PR opens; cycle 2 is one batched incremental review; cycle 3 only when cycle 2 found a valid issue; the ledger refuses a 4th.
- Close each cycle with `deploy_review_cycle.py finish --head "$HEAD" --result clean|findings`; open the next with `next` then `start`.
- Read the reviews for the exact HEAD from the reviews, inline comments and issue comments endpoints; a green check is not a review.
- Fix every valid finding, including pre-existing ones; ignore only pure style nits.
- Reply to every comment with `[FIXED]`, `[IGNORED]`, `[DELEGATED]` or `[POST-MERGE REPAIR]`.
- If cycle 3 still has valid findings, defer the non-security ones with `deploy_review_cycle.py override` and merge; security or prod-impacting findings block.
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
| Production semantics | always, after the lanes above |
| AgentCard production lifecycle | AgentCard or payment paths changed |
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
