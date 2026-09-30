---
id: 2026-09-03-shared-agentcard-cardholder-contention-closes-card-mid-checkout
date: 2026-09-03
title: Foreign closure of a shared sandbox card stalls payment settlement for 10 minutes
surface: back-end
component: agentcard-sandbox-settlement
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/agentcard/sandbox-settlement.ts readPan failure branch
symptoms:
  - Expected attention kind no further attention request, observed payment_approval
  - card_closed
  - Reuse liveness check failed; treating card as consumed
  - Could not read the Rose card for a candidate purchase
tags:
  - agentcard
  - payments
  - benchmark-fixture
  - deploy-gate
  - sandbox
sources:
  - agent d12b582c-f7ec-419e-9633-8e1d7b882900
  - agent a4a282c5-697c-49b0-b553-9d0e0c6fbbf7
repro: back-end/src/tests/blackbox/treasury-rails-card-cleanup.blackbox.ts
status: open
---

## Problem

During a `/deploy` Step 6a AgentCard lifecycle gate, `agent-payment-setup-resume`
failed while its three sibling payment tasks passed on the same isolated stack.
The agent minted a sandbox card at 22:41:33, typed the PAN and clicked Pay at
22:42:12, and then every `POST /api/test-payment/confirm` returned 502 because
`get_card_details` reported `card_closed`. The agent re-clicked Pay for ten
minutes (502s at 22:42:13, 22:43:04, 22:43:58, 22:45:14, 22:46:14, 22:47:25)
until the purchase was marked consumed at 22:52:09 and Rose correctly raised a
third attention request (`payment_approval`). The runner's
`expected_attention_kinds` sequence rejects a third request, so the task failed
with the agent left ACTIVE at 700s.

## Diagnosis

The AgentCard sandbox cardholder `andy@roselabs.ai` is a globally shared,
externally mutable fixture. It is first in `BENCHMARK_CARDHOLDER_EMAILS`
(`back-end/src/providers/agentcard/benchmark-float.ts`), ahead of the dedicated
`agentcard-benchmark@roselabs.ai`. During this run `list_cards` / `list_transfers`
showed ten foreign cards created between 22:36 and 23:00 and five headroom
recoveries that this backend never initiated. Some other consumer of that
cardholder closed our in-flight card before checkout.

This is not a Rose regression: the isolated stack issued exactly two
`close_card` calls in its entire lifetime (22:59:48 and 23:01:53), both for a
different card belonging to the abandonment task. Idle auto-close was ruled out
by live probe — an idle unspent card stayed OPEN with a readable PAN for over
200s, and one orphan survived five minutes. `recover_funds` returns
`insufficient_headroom` and does not close open cards.

## Solution

No product code was changed. The trigger is an external actor on a shared
fixture, and the one adjacent code defect is not safe to change blindly (see
below). The gate was re-run after confirming the branch was not the cause.

### Contributing defect (still open)

`sandbox-settlement.ts` treats only a 404 as a benign skip
(`isCardNotFoundFailure` -> `skip_not_found`). A `card_closed` provider error
falls through to a 502 `AgentCardSandboxSettlementError`, which the checkout
surface retries indefinitely — hence ten minutes of re-clicking Pay instead of
failing fast. `back-end/src/providers/purchaseCleanup.ts` already classifies
`card_closed` as an authoritative closed-card state via
`isClosedCardDetailsError`. The two modules therefore disagree about the same
provider code.

The obvious fix — treating `card_closed` as a skip in settlement — is NOT
safe to apply blindly. That branch deliberately fails closed: silently skipping
mislabels a genuine Rose card as an ordinary card, leaving its purchase HELD
while Stripe charges the PAN raw. A correct fix needs to distinguish "this
closed card cannot be the PAN being entered" from "we failed to read the real
Rose card", and must carry its own regression test. It was therefore recorded
here rather than rushed into an unrelated deploy.

## Human feedback

None specific to this failure. The operator directed the deploy to keep going
and retry rather than stop at the first red gate.

## Reusable lesson

A benchmark that mutates a globally shared third-party fixture is only as
reliable as its exclusivity. Before blaming the branch under deploy for a
payment/provider failure, count the provider mutations the local stack actually
issued: here the stack made exactly two `close_card` calls and neither targeted
the failing card, which alone falsified "our code closed it" and redirected the
investigation to ten foreign cards on the same cardholder. Also: when two
modules classify the SAME provider error code differently, one of them is
wrong — but the safe direction is not automatically the permissive one. Fail
closed on money paths, and record the disagreement instead of flipping it
inside an unrelated change.

## Prevention

1. Give the AgentCard lifecycle gate exclusive use of a cardholder. The
   dedicated `agentcard-benchmark@roselabs.ai` already exists and is verified;
   preferring it for benchmark runs would remove the shared-fixture contention
   entirely, provided its float is provisioned to the same >= $500 floor.
2. Make `card_closed` fail fast in `sandbox-settlement.ts` under the safety
   constraint described above, so a closed card ends the checkout immediately
   instead of burning the task's whole timeout budget.
3. Do not run the AgentCard gate concurrently from more than one machine while
   the shared cardholder remains first preference.

## 2026-09-30 recurrence: treasury test closed foreign cards

The local AgentCard lifecycle gate failed `agent-payment-idempotent-abandonment`
for agent `6baad852-3cad-4d0a-89cd-2623e585b101`. Its two sequential browser
tasks sent the same purchase fingerprint (`ed2c4449…b8177`) for the same
agent. The first request minted a card at 01:19:29Z and left checkout
unsubmitted. At 01:21:14Z, the second request's liveness check got AgentCard
`card_closed` for that card; Rose marked the first purchase `CLEARED` and minted
a second card at 01:21:19Z. The differing last four prevented checkout, and
the task timed out at its 900-second cap. This local backend issued no
`close_card` call for the first card. The provider response proves closure but
does not identify the external caller that closed this particular card.

The current sandbox org differs from the earlier case: live read-only
`list_cardholders` returned `agentcard-benchmark@roselabs.ai` as verified,
and its ID matches the configured fixture cardholder (`…gfto`). The old
`andy@roselabs.ai` candidate was absent. All four lifecycle tasks in this
isolated stack minted against `…gfto`; other workspaces using the same sandbox
org credentials can also target it. Selecting the dedicated email again would
therefore select the same ID and would not isolate the run.

The owned cross-workspace hazard is in
`back-end/src/tests/blackbox/treasury-rails.blackbox.ts`: its final cleanup
listed every OPEN card on this shared cardholder and closed each one, including
cards minted by other active workspaces. The safe cleanup now filters to card
IDs returned by this test's own `create_card`. A permanent owning-boundary
blackbox supplies one owned OPEN card and one foreign OPEN card. Before the fix,
`npx tsx src/tests/blackbox/treasury-rails-card-cleanup.blackbox.ts` failed
with `2 !== 1` because both cards were closed. After the fix, the identical
command passed, leaving the foreign card OPEN. The backend blackbox runner
discovers and passes this test. This removes a proven mechanism, while the
specific external caller in the failed run remains unattributed.

The exact unchanged `agent-payment-idempotent-abandonment` benchmark still
needs a passing local run after this fix before this RCA can be marked fixed.
