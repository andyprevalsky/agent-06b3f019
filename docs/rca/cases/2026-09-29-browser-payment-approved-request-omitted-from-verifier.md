---
id: 2026-09-29-browser-payment-approved-request-omitted-from-verifier
date: 2026-09-29
title: Browser payment verifier lost the approved request after card issuance
surface: agents
component: spawn-browser-agent-v3 / payment approval resume and verifier evidence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py _build_payment_card_verifier_evidence — card approval resume retained last four but dropped merchant, total, and line items before verifier context assembly"
symptoms:
  - agent-payment-idempotent-abandonment timed out after 901s with status PAUSED
  - First browser task received an approved card and left checkout unsubmitted
  - Browser verifier repeatedly scored 0.5 for missing card request details
tags:
  - browser
  - payment
  - agentcard
  - verifier
  - smoke
  - timeout
sources:
  - agent acc7e8d6-99a1-4729-a2cf-0dd70aa89597
  - benchmark run agents/benchmarks/runs/20260929_132530_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json
  - agent acc7e8d6-99a1-4729-a2cf-0dd70aa89597 first verifier dump .llm-dumps/acc7e8d6-99a1-4729-a2cf-0dd70aa89597/1790687272554-dbaea4be209b-verifier_browser.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_payment_card_verifier_evidence_links_approved_request_without_secrets
status: open
---

## Problem

The local AgentCard lifecycle batch passed three tasks and timed out on
`agent-payment-idempotent-abandonment` at 924s wall clock. The root agent was
PAUSED in its first `spawn_browser_agent` call. That browser task had selected
the exact three products, requested a $43.96 card, received approved last four
7406, entered the card, and left checkout unsubmitted. Its first verifier call
scored 0.5; repeated completion attempts consumed the remaining task time.

The failed agent's latency summary measured 895.9s in `tool_dispatch` and
904.7s in `spawn_browser_agent_activity_v3`. The first saved verifier request
contained zero occurrences of `request_payment_card`; the only trusted card
tool result said `Approved one-time payment card last four: 7406`. The verifier
repeatedly requested the missing merchant, amount, and order. A previous passing
AgentCard run's verifier requests also omitted the request, so the earlier pass
depended on a more permissive judgment rather than a complete evidence contract.

## Diagnosis

Archive searches: `Timeout after 901s PAUSED browser agent payment abandonment`,
`browser activity wait repeated LLM errors agent never completes`, and
`payment_card_ready verifier merchant amount order request_payment_card`.
`2026-09-06-payment-abandonment-archived-before-browser-terminal` is related by
task family but has a different first bad boundary. This evidence gap is novel.

Critical path: `request_payment_card` validated the order → workflow normalized
and approved its payload → card minted → workflow resumed the browser with only
`payment_card_last4` → `_build_payment_card_verifier_evidence` emitted last four
alone → verifier could not connect the card to the requested order → browser
repeated `attempt_completion` and timed out. The request action was absent from
the first verifier context because the activity returned before its normal
action-history result path. Even a later action-history entry could age out of
the verifier's bounded 30-action window.

The problem class is a cross-activity evidence contract gap. A more general
attempt to preserve the entire browser action history would be unbounded and
would still leave the approved card and request in separate results. The
approval boundary can instead retain the small, authoritative request fields
alongside the minted last four. This also covers any later write-lock or auth
resume after card issuance. At 10k agents, this adds one bounded per-browser
resume payload and one verifier tool result; it creates no shared fan-in.

## Reproduction and verification

Before the fix, direct execution of the two registered blackbox functions
`test_manager_payment_card_approval_uses_registered_activity_names_and_resumes`
and `test_payment_card_verifier_evidence_links_approved_request_without_secrets` failed
with `KeyError: 'payment_card_request'` and `TypeError:
_build_payment_card_verifier_evidence() takes 1 positional argument but 2 were
given`. The same functions passed after the fix. The added
`test_approved_payment_request_is_available_to_browser_verifier` confirms the
request reaches the assembled verifier context. The full owning domain passed:

```text
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py spawn-browser-agent-v3
Results: 1 passed, 0 failed (41.9s)
```

The exact unchanged benchmark has not yet been rerun on the fixed worker.
The parent deploy loop owns that full AgentCard gate. Keep this case open until
the benchmark passes with a working frontend link and record its run here.

## Solution

The payment approval resume now carries a whitelisted summary of the approved
merchant, currency, total, and line items. The verifier's trusted
`payment_card_ready` result presents those fields together with the minted card
last four. Card number, CVV, user ID, and purchase fingerprint are excluded.
The same evidence is passed to both normal completion and final synthesis.

## Human feedback

No new feedback recorded. The standing deploy instruction forbids timeout,
prompt, and evaluator changes for this failure.

## Reusable lesson

When an activity resumes after a user approval, carry the small trusted facts
that later verification requires across the activity boundary. A verifier
cannot reliably reconstruct an approved request from a card's last four digits
or from a bounded browser action history.
