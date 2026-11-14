---
id: 2026-11-12-agentcard-org-401-flap-unsealed-owned-payment-stall-cleanup
date: 2026-11-12
title: An AgentCard org 401 flap failed the owned-cleanup release-stall proof (one post-deadline read) and flipped the stalled reclaim to RECLAIM_FAILED, so smoke cleanup raised and runtime evidence was never sealed
surface: cross
component: owned-cloud-payment-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _owned_payments_release_stalled — after _finalize_owned_root_payments spent its whole 180 s drain on the exact AgentCard release stall, the stall proof issued one provider-backed GET /api/test-payment/lifecycle after that deadline and returned False on any read error; back-end/src/providers/wallet-funding.ts reclaimUserWalletFunding rethrew the same typed org 401 (only 429 text was tolerated), so reclaimPurchaseWalletFunding persisted the stalled RECLAIMING lease as RECLAIM_FAILED
symptoms:
  - "owned cloud evidence finalization failed: 07bd0d5a-e1c5-466b-a2fc-7881d8388fa4: TimeoutError"
  - "Cloud cleanup failed: payment: TimeoutError"
  - "FATAL: benchmark root cleanup was not confirmed; refusing guest cleanup acknowledgement"
  - "Failed to get payment lifecycle: 401 {\"error\":\"AgentCard Organization MCP list_transfers failed: Invalid or expired organization token\",\"code\":\"agentcard_org_mcp_unauthorized\"}"
  - "walletFunding RECLAIMING -> RECLAIM_FAILED (purchase HELD, card CLOSED balance 0, transfer consumed releasedCents 0)"
tags:
  - agentcard
  - organization-mcp
  - auth
  - deploy-smoke
  - owned-cleanup
  - agent-payment-abandonment
  - agent-payment-idempotent-abandonment
  - release-stall
sources:
  - PR #1975 smoke round 3 (ref 4130dc70ed, fleet owner 273bc651e8be4c62a1361ac9bc21e253, agent 07bd0d5a-e1c5-466b-a2fc-7881d8388fa4)
  - PR #1981 smoke round 6 (ref 464d92d7b889, owner d2c05aa9721d46cba5a4b15932362754, agent ece20d8a-d270-485e-a39a-bed69a53ba0b)
  - PR #1983 smoke round 6 (ref fc38b4cd76, owner ca4a89a4503d4f70a3f38c84991a2386, agent 483007f4-e7eb-4dba-bf93-53951a50edb3)
  - agent 07bd0d5a-e1c5-466b-a2fc-7881d8388fa4
  - agent ece20d8a-d270-485e-a39a-bed69a53ba0b
  - agent 483007f4-e7eb-4dba-bf93-53951a50edb3
  - PR #1989
  - commit 96261bed2426bdbfc927576b3b3549bee8ed8ecd
  - agent 4db75a57-ae8d-46a2-b95f-0a940a9070e5
repro: cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py benchmark (case owned_release_stall_proof_survives_auth_flap_within_deadline); cd back-end && npx tsx src/tests/unit/agentcard-wallet-funding.test.ts
status: fixed
---

## Problem

On 2026-11-12 three deploy smokes on unrelated PRs (#1975, #1981, #1983) ended INFRA:
all 12 smoke cases UNVERIFIED, `lingering_group=true`, and `--recover-stale-owner`
refused with `unbound fresh allocation` because runtime evidence was never sealed.

In each case an AgentCard payment root still held the standing sandbox release stall
when owned cleanup ran: purchase HELD, card CLOSED with balance 0, transfer consumed
with releasedCents 0. In #1975 and #1981 the task had already been natively SKIPPED on
that stall (557 s and 640 s). In #1983 `agent-payment-idempotent-abandonment` was a
genuine native FAIL (`Timeout after 904s`), and its leftover HELD purchase entered the
same stall when cleanup abandoned it. The guest driver then raised
`owned cloud evidence finalization failed: <root>: TimeoutError` and the task row became
`Cloud cleanup failed: payment: TimeoutError`. The driver logged
`benchmark root cleanup evidence: state=failed` and refused the guest cleanup
acknowledgement, so `remote-logs/runtime-evidence/manifest.json` was never collected.

The printed run records carry `cloud_cleanup_evidence`, which shows the cause:

- #1975 and #1983 have no `agentcard_release_stall_lifecycles` key, so the stall proof's
  lifecycle read raised. The same run logged repeated
  `Failed to get payment lifecycle: 401 ... Invalid or expired organization token`.
- #1975's final `payment_snapshot` row was `HELD` / `RECLAIM_FAILED`, while every earlier
  snapshot (`before`, `after`, `final`) was `RECLAIMING`. #1981 recorded the same
  `RECLAIMING -> RECLAIM_FAILED` transition. #1983's final row stayed `RECLAIMING`.

## Diagnosis

Related cases: 2026-11-08-agentcard-org-read-auth-retry-shorter-than-provider-401-flap (same provider flap, earlier boundary) and 2026-10-02-agentcard-abandonment-closed-card-transfer-never-released (the waived stall itself).
The extra driver strings were `benchmark root cleanup evidence: state=failed`, `driver cleanup evidence interrupt_status=1 cleanup_ack=0`, and stale-owner recovery's `ValueError: unbound fresh allocation` with `runtime-evidence/manifest.json was never collected`.

1. The await that times out is `_finalize_owned_root_payments`'s
   `asyncio.timeout(PAYMENT_CLEANUP_TIMEOUT_SECONDS=180)` drain. It fires only after a
   stall, by design: a released purchase becomes terminal and the drain returns, while a
   stalled one stays pending until the deadline. That makes every stall depend on the
   post-timeout classifier `_owned_payments_release_stalled`.
2. That classifier issued exactly one provider-backed lifecycle read after the deadline
   and returned False on any exception. AgentCard's org-token 401 flap (see the
   2026-11-08 case) now outlasts the runtime's 15 s read auth-flap window, so the single
   read failed. That failure turned a waived stall into `payment: TimeoutError` and a
   batch RuntimeError.
3. The finalization abandonment POST, and the minute cron, retry the stale RECLAIMING
   lease (older than 2 min). `reclaimUserWalletFunding` polls `list_transfers`, but only
   429 text was tolerated, so the typed 401 surfaced. `reclaimPurchaseWalletFunding`
   then called `markWalletFundingReclaimFailed`, turning a still-pending release into
   RECLAIM_FAILED. The waiver requires funding RECLAIMING, so even a successful read could
   no longer qualify.
4. The driver only acknowledges cleanup after root cleanup succeeds. The guest therefore
   never sealed runtime evidence, and stale-owner recovery correctly refused the unbound
   allocation.

Local repros, unchanged before and after:

- `test_owned_release_stall_proof_survives_agentcard_auth_flap_within_cleanup_deadline`
  drives the real drain and classifier with an alternating 401 flap that also fails
  every post-deadline read. On main it raised
  `owned cloud evidence finalization failed: ...: TimeoutError`. With the fix it passes.
- `assertOrgAuthFlapLeavesReleasePending` in `agentcard-wallet-funding.test.ts` failed on
  main with `AgentCardOrgRuntimeError: ... Invalid or expired organization token` and
  passes with the fix.

## Solution

- `_finalize_owned_root_payments` takes `observe_release_stall`. It is set only for
  catalog release-waiver tasks with the waiver enabled. While every pending purchase is
  HELD/RECLAIMING it records a complete lifecycle observation inside the unchanged
  180 s deadline, at the task reconciliation cadence (10 s). A failed read keeps the
  previous complete observation and records the error count.
- `_owned_payments_release_stalled` uses that in-window observation. It reads afresh only
  when none exists. The unchanged waiver predicate still requires the final ledger rows,
  read successfully at the deadline, to be HELD/RECLAIMING with the same purchase, payment
  intent, total, transfer and card as the observed exact stall. A ledger that leaves the
  stall (e.g. RECLAIM_FAILED) or a foreign card stays a strict ERROR.
- `reclaimUserWalletFunding` treats provider backpressure as an unobserved poll, the same
  typed set the benchmark float uses: `agentcard_org_mcp_rate_limited`,
  `agentcard_org_mcp_unauthorized` with status 401, `agentcard_org_mcp_unavailable` with
  status 503, plus the old 429 text. A window with no release ends as
  `agentcard_company_transfer_release_pending`, so the lease stays RECLAIMING for the
  existing stale-lease retry. 403s, other provider errors and non-provider errors still
  fail the reclaim.
- No timeout, retry budget, task, evaluator or waiver predicate changed. No card is
  minted or retried.

Shipped in PR #1989 (merge 96261bed2426bdbfc927576b3b3549bee8ed8ecd, 2026-11-13). Both regressions ran
inside that deploy's gates: agents-coverage-blackbox `✅ owned_release_stall_proof_survives_auth_flap_within_deadline`
and backend-coverage `PASS agentcard-wallet-funding.test.ts`. Live outcome: that deploy's smoke on head
b048ad305b79 ran `agent-payment-abandonment` (agent 4db75a57-ae8d-46a2-b95f-0a940a9070e5) into the real
standing release stall, card CLOSED balance 0, transfer consumed releasedCents 0 on $43.96 test-mode. The
in-window observation (2026-11-13T00:27:56Z) proved the stall. Owned cleanup recorded `errors: []` plus the
`payment:` warning, the native row stayed SKIPPED, `guest-shutdown.confirmed` was written and
`remote-logs/runtime-evidence/manifest.json` was sealed. The smoke receipt was complete with
`lingering_group=false` (13 PASS plus one `resource_skip` `agentcard_release_stall`), not INFRA. No 401 flap
occurred in that run, so the flap path is covered by the two regressions rather than live.

Sibling failures prevented: any owned-cleanup classification that depends on a
provider read issued after its own deadline, and any reclaim that loses its pending
lease to a provider auth flap.

10k agents: observation runs only for stalled sandbox lifecycle roots in owned benchmark
cleanup. It costs at most one lifecycle read per 10 s per stalled root within the
existing 180 s window, and nothing in production request paths. The reclaim change
removes a write (RECLAIM_FAILED) and adds no requests.

## Human feedback

Andy (2026-11-12, goal brief): find which await times out and why it fires only after a
stall. Never raise timeouts. Never mint or retry cards after a confirmed stall. A stalled
card must still finish cleanup and seal evidence within its existing deadline. Register a
regression in the deploy path.

## Reusable lesson

Never let a cleanup verdict depend on one provider read issued after the cleanup's own deadline: observe inside the deadline, bind the observation to the final authoritative ledger, and never persist provider backpressure as a failed state transition.
