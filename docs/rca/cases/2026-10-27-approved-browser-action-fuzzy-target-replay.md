---
id: 2026-10-27-approved-browser-action-fuzzy-target-replay
date: 2026-10-27
title: Approval replay selected an unrelated sign-in control through cache similarity scoring
surface: agents
component: browser-approved-target
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py approval continuation automatically replays a blocked UI tool through the demo-cache fuzzy target remapper instead of resolving its permission result for the actor
symptoms:
  - "Place Order index 24513 replayed as Close Sign in index 1413"
  - "Executed after write lock approval"
  - "Cannot verify the approved browser action target"
tags:
  - browser
  - approval-resume
  - state-continuity
sources:
  - agent 3392bb69-807b-4ef9-a671-2e5eeb92efa7
  - commit 31d769b908da654b419f68e2a3cefd914703ef0e
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

After the same agent's checkout approval, captured browser action history
step 46 carries the original Place Order reasoning but targets index 1413,
Close Sign in or Sign up. Step 47 explicitly says Executed after write lock
approval. The model made no new click selecting that sign-in control. Its later
story that it accidentally typed apartment number 1413 was not a tool-call fact.

## Diagnosis

Critical path: model click(24513) → needs_write_approval → stored pending action
and signature → approval → refreshed DOM → fuzzy cache remapper → action.
Generic matching tag/type/role clears the cache scorer's threshold and remaps
to the unrelated login button at score 96. If no candidate clears the threshold,
the old helper can leave a stale index executable. A human authorization
boundary was using best-match replay instead of validating the approved target.
The upstream loss of signed-in browser state is a separate cause, recorded in
2026-10-27-approval-wait-omits-private-browser-checkpoint.

Owning permanent command:
`cd agents && source venv/bin/activate && PYTHONPATH=.:tests/blackbox python -m pytest --import-mode=importlib tests/blackbox/spawn_browser_agent_v3.blackbox.py -q -k pending_write_lock`.
Historical identity-guard tests on the original helper: two failed / one passed, 3.22s.
That superseded candidate passed three in 1.33s and five repeated runs. Its controls covered
missing, duplicate, clipped and drifted signatures, stale-index collisions,
nested indexes, coordinate-only replay and the real resumed-activity path.
These are causal tests, not proof of a live DoorDash order.

Archive searches: `needs_write_approval remap` and `approved click wrong target
identity`; related payment evidence/observability cases have different first-bad
boundaries. This is a new related defect.

## Solution

The earlier B2r3 target-identity guard is superseded by the user's simpler
continuation contract. Implemented locally, not deployed: after actual approval,
update the original correlated blocked tool result in place to
`write_permission_granted`, explicitly recording `action_executed=false` and
"Permission granted; the original action was not executed. Retry your action."
The actor then continues with its ordinary tools and decides whether to retry
or observe first.

There is no queued automatic executor branch, approval target fuzzy remapping,
approval-only identity validator, additional tool, or synthetic stale-action
failure. The existing payment-card result resolver is generalized and reused
so the original assistant/tool call ID and arguments remain paired, no new
conversation pair is inserted, and repeated resolution does not duplicate the
result. The same principle applies to the simulated browser continuation.

Existing grant storage and validation remain in use: typed grants retain their
120-second timeout; purchase/payment merchant site grants persist within the
existing resumed browser activity and do not spread to a new activity or an
unrelated site. A real actor-selected tool failure remains visible and can be
followed by ordinary fresh observation and retry under that grant. No action is
reported as executed merely because permission was granted.

The revised focused checks use the actual service_actions executor and manager
approval continuation. They verify no execution before the next actor decision,
original tool-result correlation and idempotence, ordinary failed retry then
fresh observation, unchanged grant scope/expiry and payment-result compatibility.
The same full-activity test fails on the preceding automatic-replay source in
5.90s; twelve focused checks passed in 8.91s on the correction. The simulated auto-replay path also fails its unchanged owning test on the
preceding source (0.54s), then passes after permission-result continuation.
The final real checkpoint E2E passed normal resume, capture-failure retention
and live auth assistance with the new actor-driven continuation, including
main/frame storage and exactly one synthetic order. The final frozen canonical run passed spawn-browser-agent-v3, browser-credentials
and world-model-harness: three domains, zero failures in 198.1s. Source hashes
remained unchanged and Ruff passed for all four affected Python files.
These are local mechanism proofs, not a DoorDash purchase or full paid-provider
benchmark success.

The separate benchmark coverage review records the missing full catalog
scenario: actual approval -> original permission result -> actor decision ->
real retry/recovery -> exactly one correct order, plus native recreation and
main/frame storage provenance. Existing live checkout tasks intentionally stop
at unresolved approval and remain unchanged. A controlled failed-retry variant
must not be graded by an unconditional zero-tool-errors criterion. The new
criteria need test-only fixture/evidence support before activation; no catalog
prompt, evaluator, timeout, history or threshold was changed by the review.

Earlier strict-global-uniqueness and node-binding candidates, their test
receipts, and NOT_GROUNDED reviews remain historical evidence. They do not
validate or authorize the final simpler continuation implementation. The old
claims about transaction/cart validation are withdrawn. The current mechanism
reuses the existing payment approval tool-result resolution pattern; the user's
explicit instruction supplies the revised behavior requirement.

At 10k agents this adds a bounded local transcript update per approved browser
activity and removes automatic replay/target matching work. It adds no DB query,
channel, subscription, shared lock, poller or new tool.


## Full Rose-agent verification, October 27 follow-up

The user required the test to run through a Rose agent rather than a scripted
ActivityEnvironment actor. A real root/browser Rose agent
`c4d90385-9b3f-497e-bb71-cf1350218c1f` completed the synthetic Canvas Shop task
in 225.8 seconds through the normal local backend, real model calls, Temporal
Cloud, actual Kernel browser and attention-request APIs. No model decisions or
browser executor results were mocked. The merchant and approving test user are
synthetic; no real payment or shipment occurs.

Before approval, the merchant ledger contained zero order attempts and the
logical browser had checkpoint revision1 and PAUSED status. After approval, the
same logical task used a different Kernel native ID. The original click's tool
result appeared once with its original call ID, permission granted and
`action_executed=false`. The actual model chose read_browser_state, then a fresh
click. The merchant validated the restored cookie, localStorage, IndexedDB and
sessionStorage and recorded exactly one accepted order, no duplicate/invalid
attempt and no duplicate approval. The root completed and reported the visible
order number. This closes the prior single-path paid-provider/full-Temporal
positive-coverage gap; intentional retry failure and iframe scenarios remain
separately covered by the component/integration tests, not this full-agent run.

The unchanged catalog `browser-auth-password-app-approval` also passed through
a real Rose agent in145.8s. The main typed-approval test is explicitly an ad hoc
functional test; no catalog task definitions or grading thresholds were changed.
Its recording and66messages were published and verified in a fresh browser.
All owned test agents, native sessions, local stack/database, merchant and tunnel
were retired. Private receipt: `.context/rca-3392/real-rose-agent-final-validation.json`.


## Final combined-source Rose verification

After integrating shared Steel/Kernel custody, partitioned frame persistence,
and same-agent denial continuation, ordinary Rose agent
`a280adfb-ddb9-427a-9d76-41e35e039f3e` repeated the positive approval flow on
the final runtime in **174.5 seconds**. It used actual root/browser models,
Temporal Cloud, Kernel, and the normal attention-request API. The merchant
recorded zero attempts before approval and exactly one valid synthetic order
afterward, with no duplicate or invalid attempt. Cookie, localStorage,
IndexedDB and sessionStorage proofs all passed across native recreation under
the same logical browser. The original click result retained its call ID and
`action_executed=false`; the next actual model action was `read_browser_state`.
No real payment or shipment occurred. This run does not add a full-model
negative-denial, intentional failed-retry, or cross-site-frame claim; owning
integration tests cover those separately.

[Final Rose recording and 84 messages](https://www.roselabs.ai/?agent-id=a280adfb-ddb9-427a-9d76-41e35e039f3e#benchmark-share=98dab579-4c4f-45b5-bc54-0bf53f495064.1795725487.6259e800cece29507247ee9e63a18b44fe7b7a50d8396de78553c521d658c403) were published
and verified in a fresh browser. The exact terminal agent, merchant and
merchant tunnel were retired; the deployment semantic stack remains owned
until its mandatory gate finishes. Runtime source binding and strict ledger:
`.context/rca-3392/final-rose-positive-validation.json`.

## Human feedback

The user explicitly required: "The test needs to be done through a rose agent".
The full-agent follow-up above satisfies that requirement for the successful
approval/resume flow; earlier scripted-model integration tests alone do not.

The user questioned why approval used fuzzy matching and initially suggested
executing the exact saved tool, allowing a real failure to return naturally to
the actor while existing permission persists. The user then superseded even
that automatic-replay approach: "we can just change whatever tool trigger the
write lock, to resolve with permission now granted, retry your action" and
"we dont need to pass any extra tools". The final implementation follows this
latest instruction. The preceding B2r3 identity-guard proposal is withdrawn.

The user also required reviewing existing benchmarks and adding meaningful
criteria there. The review distinguishes executable coverage from proposed
criteria that still need fixture and evaluator support; a local integration
pass is not relabeled as a full catalog benchmark pass.

## Reusable lesson

Resolve the approved tool's permission result and let the ordinary actor continue instead of automatically replaying or substituting a saved UI target.
