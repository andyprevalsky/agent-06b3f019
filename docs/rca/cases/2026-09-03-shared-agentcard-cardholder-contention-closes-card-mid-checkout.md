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

A second isolated run on September 30 (`3f47fcda-ca99-4313-91f6-e684a05cb333`)
finished its checkout after the first card closed during the sequential reuse
check. The agent minted a replacement, so the lifecycle contained two purchases,
two wallet fundings, and two cards. The benchmark initially reported a pass
because its expected lifecycle did not assert those counts. The task contract
now requires exactly one of each, and a regression test confirms that this
archived run fails validation. That earlier green result does not close this
case; the stricter exact benchmark needs a new pass.

The next strict rerun (`88706c44-eb1a-4258-8714-6ad8a930facc`) failed for a
separate, fully attributed fingerprint difference. Its first browser sent the
three bare product titles; its second browser sent the same titles with a
redundant ` - x1` suffix while also setting `quantity: 1`. All other receipt
fields matched. The two purchase fingerprints differed, so the backend minted
another card. Both the agents-side fingerprint builder and the backend's
stored-receipt backfill now ignore that exact matching quantity echo. A replay
of the two archived request payloads produces one canonical fingerprint, and
the tests keep a mismatched quantity distinct. The next exact live run
(`49095574-4a49-4d4b-ad21-ee8b0b2da186`) passed in 289 seconds: both browser
requests used fingerprint `d54a9df1…`, the second lookup returned `reusable:
true`, and both payment-card responses returned the same provider card ID
`card_b4d522c1e7d8eca7f9af1aa9`. The terminal lifecycle had one purchase,
one wallet funding, one Stripe payment intent, and one local card. This proves
the idempotency path in that run; the shared cardholder still needs provider
isolation to prevent unrelated workspaces from affecting future runs.

The full four-task AgentCard gate then exposed two more browser-rendering
variants (`20260930_025123_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json`):
setup/resume sent `http://placehold.co/...` for the three image URLs expected
with `https://` in the checkout fixture, and the idempotency task's second
browser appended `x1 (Rose Labs Test Payment)` to each product title. Its two
fingerprints differed, giving two purchases. The payment payload now upgrades
only the known placeholder image host to HTTPS; both fingerprint builders
strip a quantity-plus-merchant suffix only when it matches the separate
quantity and merchant fields. Replaying the archived requests now produces
secure receipt image URLs and one fingerprint.

The focused live rerun (`1c4ebfa8-63db-4e4a-a468-e4749d69e6dc`) passed both
affected tasks. Setup/resume completed onboarding and checkout; idempotency's
second browser returned `reusable: true` for fingerprint `9b7392f8…` and the
same card ID `card_3f56552739e49626483f0248`. Its terminal lifecycle had one
purchase, one funding, and one card. The four-task deploy gate remains pending.

## 2026-10-01 recurrence: verified cart-summary text changed the purchase key

The four-task local deploy gate failed `agent-payment-idempotent-abandonment`
for agent `847cc7c7-ffe9-4ced-aecd-44bfe6d49998` at the 900-second cap.
Its first browser submitted item names such as
`Aurora Notebook - x1 - $12.00 (Rose Labs Test Payment checkout)`, while its
second browser submitted the bare product titles. Product URLs, structured
quantities, unit prices, fees, merchant, and total were unchanged. The agents
fingerprinted these as `8fb86c27…` and `8bd7b485…`; the second lookup returned
`reusable: false` and minted purchase `5d2cbd4b…` after the first had minted
`b9bdc4f5…`. The second browser then called `request_payment_card` four more
times, each rejected with `Payment approval is already complete. Do not call
request_payment_card again`, and spent 622 seconds in that browser activity.

The first bad boundary was both sides of purchase fingerprint canonicalization:
they recognized some repeated quantity/price display forms but not the combined
cart-summary form above. The new blackboxes
`agents/tests/blackbox/request_payment_card.blackbox.py` and
`back-end/src/tests/blackbox/purchases-fingerprint.blackbox.ts` capture the
form and assert reuse only when the echoed quantity, price, and merchant match
the structured receipt. Before the fix,
`agents/venv/bin/python agents/tests/blackbox/request_payment_card.blackbox.py`
failed with `the same product URL, quantity, price, and merchant must reuse its
card`; `cd back-end && npx tsx
src/tests/blackbox/purchases-fingerprint.blackbox.ts` failed with `the captured
first-browser name must resolve to the same held card as the bare title`. After
the Python and TypeScript canonicalizers were updated, those identical commands
passed; conflicting quantity, price, and merchant annotations remain distinct.
The exact unchanged paid benchmark still requires a post-fix local pass before
this recurrence can be called fixed.

Archive searches: `Timeout after 900s browser_activity_wait payment AgentCard`
and `browser agent spent long time repeated navigation payments idempotent
abandonment`. This is a recurrence of the receipt fingerprint drift already
recorded above, not another sandbox cardholder closure. Human feedback for this
recurrence: the operator directed the agent to fix the runtime issue without
raising timeouts, weakening tests, or touching the separate Explore issue.

## 2026-10-03 recurrence: treasury-rails unused card never released under foreign load

The PR #1401 deploy backend coverage lane failed `treasury-rails` with
`transfer for card_d9109871658de3d93171a63b ended in "consumed" — an unused
card must reclaim/release, not stay consumed`. The test minted $13.00 at
03:47:34Z, closed it unused at 03:47:37Z, and swept `recover_funds` every
~10 seconds for 240 seconds. The sweeps recovered $14.48, $37.21, and $37.21,
which match the spent-card residuals of three foreign cards on the same
cardholder (`card_2585635f…`, `card_09f75bf8…`, `card_cf353deb…`). No sweep
returned this card's $13.00, and its transfer stayed `consumed` with
`released_cents: 0`.

A read-only provider check at about 04:00Z found the card `CLOSED` with $0.00
remaining. The transfer was still `consumed` with `released_cents: 0`. Between
03:44Z and 03:58Z, the provider listed nine other cards on the one
mint-capable cardholder. They came from $43.96 and $21.23 payment checkouts and
another workspace's identical $13.00 treasury mint. At 03:57:25Z, a foreign
$43.96 mint (`card_0ecf64c3…`) netted entirely against idle residual
(`transferred_cents: 0`). This proves that unrecovered residual was on the
cardholder even though this test's sweeps could not recover it during its
window.

This machine did not originate any of that activity. The coverage run issued
exactly one `create_card` and one `close_card`, both for this test's card. The
long-running local stack issued none in the window. Branch code did not touch
the path: every org MCP call succeeded on attempt 1, so the branch's
throttle-retry change never engaged. The same test passed in the four earlier
backend coverage runs of this deploy (164–196 seconds each).

Classification: third-party / shared-fixture contention, the same class as this
case. How the provider attributes residual to transfers while foreign cards are
open is not visible through the MCP, so the exact mechanism remains an open
visibility gap. Relaxing the assertion to accept pool or residual movement
would reopen the foreign-residual false pass fixed in `13fb3fa48`. Prevention
item 1 still applies: the gate needs its own mint-capable cardholder. Setting
one up is a provider fixture change (a new verified sandbox cardholder) that
requires an operator.
