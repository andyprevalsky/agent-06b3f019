---
id: 2026-11-07-verifier-history-stripped-card-receipt-image-urls-after-private-entry
date: 2026-11-07
title: The browser verifier's action history lost a card request's image URLs once the card was typed, so a paid checkout looped at 50% until the 900 s timeout
surface: harness
component: browser-verifier-action-history
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py ActionHistory._model_visible_entry re-applied DOMService.model_visible_value on every get_entries(); after mark_secret_used, omit_media dropped every image_url key, including the typed HTTP(S) image URLs of the earlier request_payment_card params and approved receipt, while the browser model's own tool message kept them via model_visible_action_result
symptoms:
  - "Timeout after 904s (task timeout=900s) | Agent status: PAUSED (expected COMPLETED)"
  - "Verifier score: 50%"
  - "the visible second-request payment_request does not contain those image URLs"
  - "Step 2's payment_request includes product URLs, ratings, review counts, prices, quantities, and fees, but does not show the Aurora Notebook, Ceramic Mug, or Canvas Tote image URL descriptors"
  - "User paused the browser agent"
tags:
  - agent-payment-idempotent-abandonment
  - browser-verifier
  - action-history
  - request_payment_card
  - private-entry
  - image_url
  - smoke
sources:
  - PR #1760 smoke campaign 71ff959741b9, run 20261107-195305-1001621-m7373978ab185, agent ce9d2ae6-c109-435d-bea4-c5fb1e5c1f1c (Benchmark Hub GET /api/benchmarks/runs/<run>/agents/<agent>; copy in .context/rca-idem-abandon/)
  - Same signature, local run af499e5b-b45c-492c-a27b-1eea0aa7f206, agent 119bdfb6-aba0-4fe8-a7ee-bce01171ce44 (five 50% verdicts citing image URLs)
  - Related cases docs/rca/cases/2026-10-20-payment-approval-finalizer-discards-recorded-receipt.md and docs/rca/cases/2026-10-22-receipt-image-provenance-limited-to-current-page.md
repro: agents tests/blackbox/spawn_browser_agent_v3.blackbox.py test_verifier_history_keeps_card_receipt_image_urls_after_private_entry (python scripts/run_blackbox_tests.py spawn-browser-agent-v3)
status: fixed
---

## Problem

The smoke task `agent-payment-idempotent-abandonment` failed in the PR #1760
deploy smoke campaign 71ff959741b9 with
`Timeout after 904s (task timeout=900s) | Agent status: PAUSED (expected COMPLETED)`.
The same source had passed the task in two earlier campaigns.

## Diagnosis

The PAUSED status is the harness's timeout teardown, not the cause (CLAUDE.md
rule 11): the second browser task's session was paused at 20:13:16, after the
900 s budget, and the root's `wait_for` woke on that notification.

Timeline of agent ce9d2ae6 (Hub transcript, 173 messages):

- 19:58:21 to 19:59:42 the first browser task requested a card (approved,
  last four 9176) and left checkout unsubmitted. Its verifier passed.
- 20:00:02 the root started the second task. Its goal asked for the card
  request "with the merchant name and full order descriptors", explicitly
  listing the three `placehold.co` image URLs.
- 20:00:17 step 2 `request_payment_card` reused purchase 457a13d9; the
  `payment_card_ready` metadata shows all three `imageUrl` values in the request.
  Steps 5 to 8 typed the card; step 10 clicked Pay; step 11 showed
  confirmation `tp_2a5c8165` by about 20:01:36.
- 20:02:20 to 20:12:55 six `attempt_completion` calls each got
  `Verifier score: 50%`, all citing the same gap: the step-2
  `payment_request` "does not contain those image URLs". The agent kept
  re-asserting the URLs through `evaluate` literals, which the verifier
  correctly refused as unobserved.

The request carried the image URLs; the verifier's copy of it did not.
`ActionHistory.get_entries()` re-projects each stored entry through
`DOMService.model_visible_value` on every read. After the card is typed,
`mark_secret_used()` sets `secret_values_used`, and `omit_media` removes every
dictionary key named `image_url`. That also erased the typed text URLs inside
the already-recorded `request_payment_card` params and approved receipt. The
browser model's own tool message kept them because
`model_visible_action_result` restores receipt image URLs, so the agent and its
verifier saw different versions of the same receipt (a contract inconsistency
between two projections of one record). The verifier builder
(`build_browser_verifier_context`) reads `action_history.get_entries()`, so it
always lost the URLs after card entry. The bug is latent in every run that
types a card after requesting it; it fails the task only when the goal makes
the image URLs load-bearing, which explains the earlier passes on the same
source. Local run af499e5b (agent 119bdfb6) shows the same five-verdict loop.

Gate: NOT_INTRODUCED for PR #1760: `git diff f4d2b5baa5 cdb8ce580a -- agents/`
is empty. The `image_url` key entered the private-entry omission list in
2209d9df6a (2026-10-14, private tool credential refs).

## Fix

One helper, `keep_receipt_image_urls`, in `agents/browser_tools/dom_service.py`
restores a receipt's HTTP(S) `image_url` strings onto its projection, still
passing each through the active redactor. It is now used by the action
projection (`model_visible_action_result`), the activity-return projection
(`_visible_activity_result` in the browser handler) and
`ActionHistory._model_visible_entry` for `request_payment_card` params and
result. Arbitrary `media`, rasters and `data:image/` payloads stay withheld
after private entry.

## Proof

Regression `verifier_history_keeps_card_receipt_image_urls_after_private_entry`
(spawn-browser-agent-v3 blackbox) builds the real verifier context from a real
`ActionHistory` bound to a real `DOMService`, records the card request, then
marks private entry. On cdb8ce580 it fails with
`verifier lost request image_url https://placehold.co/320x220/png?text=Aurora+Notebook`;
with the fix it passes and still asserts that `media` is withheld and the card
number never reaches the verifier.

Exact benchmark outcome gate, `scripts/run-bench --local agent-payment-idempotent-abandonment`
(task definition byte-identical on both revisions), verifier dumps read from
`.llm-dumps/<agent>/…-verifier_browser.json`:

- Buggy cdb8ce580, agent 2d25a74f (run 99cd48b0): outcome PASSED (349.5 s) by
  model variance, but the first-bad boundary reproduced. The second task's
  verifier input before card entry (steps 1–4) carried 3 `image_url` values in
  the step-3 receipt; its verifier input after card entry (steps 5–9) carried
  0 for the same step-3 receipt.
- Fixed 1b4748e347, agent 52c26100 (run da81d3dc): PASSED (382.5 s); both of the
  second task's verifier calls after card entry carry all 3 image URLs in the
  step-3 receipt.

Adjacent observation, not addressed here: in both runs the verifier's receipt
shows the merchant as `{{secret:card_name}} Test Payment` because the issued
card's name equals the merchant prefix and is masked as a secret value.

## Problem class

Logical inconsistency in harness contracts: a privacy policy applied lazily on
read rewrote history that was already recorded, so two consumers of one
receipt disagreed. Projections of recorded evidence must not change after the
fact; typed operational fields belong to the record, not to the page media
policy.
