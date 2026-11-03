# swap-harness handoff — devbox 1ed69a70-e33f-402d-b101-217cc36e4cb2 (Codex → Claude)

Nonsecret. Prepared 2026-10-18 (UTC) by the Claude migration worker on the OLD devbox.

## Goal and completion criteria
Original ask (2026-10-14, user): "/rca the following bug for agent with ID: 47a8ff5f-b40b-4e1b-8219-3cda65650836 — Why did this agent not attempt to enter my Gmail password for me? I thought we have auth benchmarks … Do we need to update request auth assistant to include 2FA actions / Gmail sign in (where u click the approve button on the app …)?"
This grew into: add the password + app-approval auth benchmark, repair the auth regressions, and `/deploy` with **every unchanged auth benchmark run to prove no regressions**. Overall goal clock start 2026-10-14T19:52:18Z (do not reset).

## Latest user steering and constraints (verbatim where possible)
- 2026-10-14 19:52 "ok this is approved / **/deploy but make sure u run all auth benchmarks to prove no regresssions**"; "auth-otp approved".
- 2026-10-15 21:43 "if you think they are truly sound, and they prove new passing and aren't overfitting, then approved, but this is a tough call so use your expert opinion" (AUTH-STABILIZE-1, snapshot 942d4bce9, scoped; see `active-handoff.json` in the private archive).
- 2026-10-16 02:50 "either give me approval request, or continue"; 03:02 "fix the failures bro".
- 2026-10-16 18:10 "**dont ask me to aprove prompt changes unless they prove it passes, u only need approval at the deploy step**".
- 2026-10-17 17:19 "continue" (latest user message).
- Standing: no merge, no production deploy, no approval flags, no review-ledger reset; unchanged benchmark tasks/prompts/evaluators/caps; never relabel old-source results for new source; report benchmark progress with the exact scorecard in `.claude/shared/benchmark-report-format.txt`; PR #1519 review ledger is not reset.
- Swap-harness authorization is checkpoint + draft PR + one replacement + archival only. It does NOT authorize merge/deploy, subscription changes, paid fallbacks, new paid benchmark runs, or relaxing the constraints above.
- Freedom and its protected instruction copies are untouched; keep it that way.

## Identity / quota
- Old devbox `1ed69a70-e33f-402d-b101-217cc36e4cb2`; main thread `ph76b0rxy1a8ed810xb8nn38v58g8p9m` (`thr_c34a6e7153cb4eaea50c27c9d61e9def`), Codex session `01a13b83-da02-7112-8c49-af20859c87b0`, last turn `01a14ae0-8d5e-7c83-bc6e-0710c3efeb7b`.
- Helpers (all idle, Codex limit): `ph77d8py…` Run RCA for /deploy auth regression (`01a13c07-…`, deploy/independent-gate lane); `ph7cs5tr…` Perform RCA for pending SMS OTP (`01a13c1c-…`); `ph792hqs…` Review four-POST decision comparison (`01a142b9-…`). The replacement owns the main task and re-delegates any still-open lanes below.
- Quota evidence (local Codex session files): `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 24th, 2026 8:40 PM.` (`usage_limit_exceeded`, 2026-10-18T02:28Z–02:32Z, `rate_limits.primary.used_percent=100` on every session). Coordinator: `ph798148z0ek3p1adb1qpv4kxd8ggn8n`.
- Harness: Codex (exhausted) → Claude, under the user's explicit override ("U swap codex into Claude") of the Codex hard exclusion for this box only.

## Branch / PR
- Task branch `review/auth-steel-main-integration-20261014`, draft PR https://github.com/Rose-Ai-Labs/rose/pull/1519 (base main). Source commit under test: `cdf0aeda05c62d90ab825340ee955e6ee97ee68d`. The checkpoint commit adds only this handoff on top of it.
- Review ledger (private copy in archive): cycle 1 initial on `897bf3a80` = findings; cycle 2 incremental on `cdf0aeda0` = completed with findings. The main thread was fixing the cycle-2 findings in **private, unadopted** copies (see below). Do not start another cycle until the fixes are batched and verified (CodeRabbit state machine in CLAUDE.md).

## Implementation / validation state at the stop (2026-10-18 ~02:28Z)
- Final original-30 auth run on source `cdf0aeda0`: `.context/benchmarks/auth-final-original30-cdf0aed-20261018` in `rose-auth-final-deploy` (group `e9a3b828-a5f0-42a5-b58e-72065de0c17b`, local/real, limits 900/1200 s, 30 attempts, 0 retries). **Terminal: 28 PASS / 2 FAIL**, controller exited, stack cleanup `clean`, owner `cleanup_verified`, cost ≈ $0.25 (Azure unpriced). Failures kept as-is: `browser-auth-minted-sms-otp` (663.9 s, agent 3933c49a-653b-4380-a963-bf250659f695; SMS root stalled waiting on user authentication then paused; RCA in progress) and `browser-auth-signup-purchase-no-subscription` (420.0 s, agent 48d3fdd9-bfa6-4a06-9876-243e360b328b; unclassified). Hub/FE durable publication and fresh-FE link verification were still **pending** at the stop — verify before citing any FE link.
- Other gates reported green earlier on the same lineage: LIVE probes (3), UI semantic 8/8, Claude E2B, controller/static/FE gates (see the 2026-10-16/17 status files in the archive). Earlier full-30 attempts on older sources (`a96f02e`, `f60a39e`) are retained history only.
- Private, UNADOPTED fixes for the cycle-2 review findings and the SMS stall (separate approval-vs-completion-score decision, credential privacy, tool admission, cleanup) are in the archive under `repair-next-primary/cdf-cycle2-root-fixes`, `cdf-explore-review`, `cdf-sms-stall-source-review`, `steel-writer-announcement-cdf-rca`, and `repair-native-original30-cdf0aed-20261018/minted-sms-otp-failure-rca`. Targeted tests were passing in isolated copies; combined verification, privacy/admission/cleanup controls and adoption were still pending. Adopting new runtime/prompt hunks requires the user's deploy-step approval flow only after they prove passing.
- Next concrete action for the replacement: verify the private archive, then reproduce the SMS-OTP failure per `/RCA` (local repro that fails, fix that passes; owning test cemented in the deploy path), combine the private fixes into one reviewed batch, re-run the unchanged auth benchmarks on the new source (new paid runs only under this task's existing authorization — confirm with the user's standing "run all auth benchmarks" instruction), then prepare the deploy-step approval request with the exact inline diff.

## Setup notes
Read `CLAUDE.md`. Fresh clone guidance in CLAUDE.md applies (authoritative env files via the project's managed env, Python 3.11 venv, Node 22 for backend/front-end). Use `ROSE_USE_SYSTEM_PG=true`, a fresh `CONDUCTOR_PORT`/`CONDUCTOR_WORKSPACE_NAME`/queue/DB identity; no copied runtime identity or env values. The old box disk was 97% full — keep ≥3 GiB free; benchmark history ledgers hydrate ~2 GB per checkout.

## Owned runtime / resources
- No Fly/cloud/sandbox/browser resources are owned by the main lane (local runs only; "No Fly allocation" per status). The 30-task run and the three earlier local benchmark stacks are `cleanup_verified`/`clean`.
- One idle helper-owned dev stack remains on the OLD box (`rose-auth-control-deploy-verification`, `scripts/run.sh --benchmark` + `step5/supervise.py` from the ph77 deploy lane, started ~02:00Z). It was left untouched (healthy, helper-owned, no consumer now). It does not transfer; the replacement starts its own.
- During preservation a scratch capture of mine briefly filled the disk to 100% (~03:25Z) before I stopped it and deleted only my own scratch output; no task file was touched. Note for any anomaly timed 03:24–03:28Z.

## Preservation inventory
Git (pushed to origin): all local-only task branches (`review/*`, `rca/*`), `feat/auth-app-approval-benchmark` (fast-forwarded to `f83bbf37f`), `refs/archive/space-recovery-20261016/*` and `auth-proof-bb7`, and every unpushed worktree HEAD under `swap-harness-archive/1ed69a70/*` (15 branches). Not pushed (pre-existing repo backups, exceed GitHub file limits, not task-owned): `refs/backup/marseille-pre-ledger-squash`, `refs/backup/schema-constraints-pre-flatten`. 34 worktrees were inventoried (listed in the archive manifest); one stash (not task-owned).
Private archive (NOT in Git): `swap-1ed69a70-private.tar.part-00..02` (+ `PARTS.SHA256SUMS`), delivered by managed message attachment to the replacement thread. After `cat part-* > swap.tar`, `tar -xf` gives `.swap-harness-private/` with `SHA256SUMS` (per-member sha256), containing: `src/task-refs.bundle` (verified Git bundle of 103 refs), `wt/<worktree>/{HEAD,status.txt,tracked.patch,untracked.tgz}` for every worktree (benchmark-history ledger appends are the bulk; deleted hydrated history files are recoverable from each HEAD), `evidence-key.tgz` (top-level `.context` status/handoff files), `nested-private-repos.tgz` (7 nested private repos), `cdf-repair-work.tgz` (private fixes above), `codex-main-session.jsonl.gz` (raw main Codex session — private), `run30/` (final run report, result, 244 MB run.json gzipped), `misc/` (review-cycle ledgers, stage log). No encryption (project-private channel); do not publish.
**Not transferred:** ~16 GB of other ignored `.context` evidence (run dumps, traces, recordings, earlier campaigns, ~3 GB of small files across 140k files) exceeds the 100 MiB attachment channel. It remains on the OLD box, which is therefore **kept (not archived)** until the user or coordinator provides a bulk transfer route or accepts the loss.

## Replacement / receipt
Stable start key `swap-harness-replacement-1ed69a70-e33f-402d-b101-217cc36e4cb2-20261018T0228Z`. Replacement ids, URL and resumed receipt are appended below once known.

## Replacement verified (appended 2026-10-18T03:45Z by the old-box worker)
- Replacement: devbox `75ad1c7a-4e51-424b-b271-4d06695fe5c7`, thread `ph74556smw66kq04ce6jr873gs8ghasd` / https://boxes.dev/thread/thr_8ecc60522a644b6fb3bba00c85eefe81 (Claude, unmuted).
- Receipt: `docs/handoffs/swap-harness-1ed69a70-e33f-402d-b101-217cc36e4cb2-resumed.json` at commit `e29200bca2c970acbfb755a1f7675e2cad72e213`. The first receipt commit `b942132d6` was invalid (content copied from an unrelated 2026-10-12 migration); it was corrected by a normal follow-up commit and is not evidence. Verified fields: old/new box, thread, harness=claude, checkpoint `0bcf17f80`, private archive 3/3 parts and 108/108 members verified, extracted outside Git.
- Old-box disposition: **KEPT, archival NOT requested.** ~16 GB of other ignored `.context` evidence (run dumps, traces, recordings, earlier campaign artifacts) is not in the transferred archive; one idle helper-owned deploy stack also remains there. Destroy only after the user/coordinator supplies a bulk transfer route or explicitly accepts the loss.
