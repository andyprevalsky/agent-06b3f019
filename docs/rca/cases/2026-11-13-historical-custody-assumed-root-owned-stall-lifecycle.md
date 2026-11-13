---
id: 2026-11-13-historical-custody-assumed-root-owned-stall-lifecycle
date: 2026-11-13
title: Historical no-retry custody crashed on a release stall owned by a browser sub-agent
surface: harness
component: deploy-historical-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_historical_custody.py historical() looked up the stall lifecycle by the native root agent id, but run_benchmark keys it by the agent that owns the purchase
symptoms:
  - "historical() snap = cleanup['agentcard_release_stall_lifecycles'][t['agent_id']] KeyError"
  - "DEPLOY_CYCLE BLOCKED: '9a3babcc-d45d-43c7-9dfb-9095fbac47b4'"
  - prepare-historical-no-retry refused a changed-source refresh and forced a full gate rerun
  - "DEPLOY_CYCLE BLOCKED: historical custody: independent failure lacks canonical pending repair"
tags:
  - deploy
  - agentcard
  - historical-custody
  - source-refresh
  - sub-agent
sources:
  - PR #1972 deploy cycle deploy-pipeline-pr1972-r7 (READY on f93b9ad17fb1, refresh to dd4b27a38f2c)
  - commit 5fecafd337de7ba0ae7860637cea53235edb4dfe (PR #1972 merge)
  - agent 9a3babcc-d45d-43c7-9dfb-9095fbac47b4 (root), 4a71ddef-34a2-4bfd-ab7a-51413c2fafa6 (purchase owner)
  - PR #2014 deploy smoke agent 6ead2d7b-e30f-4852-b149-9cbe7fe4f197 (stall row ended native ERROR)
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_historical_custody_binds_subagent_owned_stall_and_refuses_unprovable_owner
status: fixed
---

## Problem

PR #1972's cycle was READY on f93b9ad17fb1 and had to refresh to dd4b27a38f2c.
`deploy_test_cycle.py prepare-historical-no-retry` crashed in `build()` →
`historical()` with `KeyError: '9a3babcc-…'`. The CLI printed only the bare id,
the refresh was refused, and the deploy had to rerun every gate.

The protected occurrence was `smoke/agent-payment-idempotent-abandonment`
(FAILED, 902 s timeout, NOT_INTRODUCED pending post-merge packet). Its archived
native row shows the runner **did** confirm a standing release stall:
`cloud_cleanup_evidence.warnings` contains the AgentCard release-stall reason,
`errors == []`, `cleanup_failure == null`. The single lifecycle is keyed by
`4a71ddef-…`, a browser sub-agent in the sealed tree
(`tree_agent_ids = [4a71ddef…, 86246544…, 9a3babcc…]`). It shows a CLOSED
zero-balance card, a consumed sandbox transfer of 4396 cents with 0 released, a
HELD purchase and RECLAIMING funding. `final.purchase_cleanup` names the same
child as the purchase agent.

## Diagnosis

In this task the browser agents call `request_payment_card`, so the purchase
row's `agent_id` is a child. `run_benchmark._owned_payments_release_stalled`
keys `agentcard_release_stall_lifecycles` by each pending purchase's `agent_id`.
It writes that map **before** judging the stall. A rejected stall is recorded
as a `payment:` entry in cleanup `errors` and as a `cleanup_failure`; an accepted
one adds the release-stall warning. So a non-empty map alone is not proof of a
stall: `known()` discovers it as a candidate, and `historical()` excludes
non-stalls through its `errors == []` / `cleanup_failure is None` checks and the
financial-shape checks. `historical()` then indexed the map with the root id and
validated the purchase join against the root. That unwritten producer/consumer
contract only held when the root itself requested the card, as in every earlier
fixture. `deploy_test_agentcard_renewal.original()` made the same root-owner
assumption. The CLI prints `str(KeyError)`, which is only the bare id, so the
original symptom was opaque.

Local repro: the archived r7 `cycle.json`, `previous-plan.json`,
`plan.candidate.json` and the native run JSON were restored at their original
absolute paths. `historical()` on unchanged main raised the identical
`KeyError: '9a3babcc-…'`. The new owning regression builds the same child-keyed
shape and fails on unchanged main with `KeyError: 'root-1'`. The renewal
sibling's regression fails on unchanged main with a lifecycle join refusal.

## Solution

`stall_lifecycle()` resolves the snapshot and its owner. It requires exactly one
self-identified snapshot whose card, transfer, purchase, funding and hold
sections are objects. Custody binds one purchase, so a second snapshot (child
or root) refuses instead of leaving a stalled purchase unbound. `historical()`
requires the owner to be in the sealed tree list and joins the final purchase on
that owner. Every existing strict check still applies: sandbox mode, consumed
transfer, zero released, closed card, HELD/RECLAIMING, matching card, transfer
and purchase identities, cleanup root and errors, sealed root, adapter closure
and native fleet closure. Renewal uses the same resolver. For a sub-agent owner
it also requires tree membership, and a missing in-task lifecycle refuses with
a typed error. Root-owned single-snapshot rows keep the same proof shape and
digests.

Absent, ambiguous, self-inconsistent, malformed or unsealed snapshots now raise
typed `ValueError`s. Deeper malformed native documents can still fail closed
with other exceptions. No provider call, card mint or reissue is added.

Replaying the real r7 state with the fix passes every snapshot, financial and
purchase-join check. It then refuses with `original adapter closure/evidence
changed`, and native closure was mocked because the fleet audit is not on this
devbox. That refusal is correct: after archival, the archived cycle's
`worker_result` path (`.context/deploy-pipeline/attempts/2/…`) was overwritten
by the later fresh dd4b27a38 cycle. That archive-durability gap is a separate
follow-up: archiving a cycle by renaming its directory leaves its absolute
attempt paths pointing at the next cycle's namespace. The fixture regression is
the only end-to-end pass. 10k-agent behavior: per-row dictionary work over one
native task, with no new I/O.

## Recurrence in the repairing deploy (PR #2014)

The same over-assumption appeared again during this repair's own deploy. In PR
#2014's smoke, agent-payment-abandonment hit the exact sandbox stall
(owt_88ebc5d1a2ed88b933dbea65, 4396 cents, released 0). Its native row ended
`ERROR`, not `FAILED`: an AgentCard org-token 401/429 storm failed the final
lifecycle reads, and `_wait_for_expected_payment_lifecycle` raised. The builder
required `benchmark_status == 'FAILED'` for a canonical pending repair, so the
refresh refused with "independent failure lacks canonical pending repair". The
only remaining path, a full rerun, would mint another card after a confirmed
stall. Custody now accepts both complete non-passing native outcomes, `FAILED`
and `ERROR`; a `PASSED` row still refuses. Regression:
`Cycle.test_historical_custody_keeps_no_retry_for_stall_row_that_ended_error`
fails on the prior builder with the live refusal and passes with the fix. The
live obligation then proved end to end, including the real native fleet
closure.

## Human feedback

The repair assignment described the occurrence as "not a release stall". The
native evidence shows a runner-confirmed stall on a sub-agent purchase in a
task that also timed out. No-retry custody therefore stays strict and now covers it.

## Reusable lesson

Join payment custody evidence on the purchase-owning agent recorded in the sealed tree, never assume the root agent owns every purchase.
