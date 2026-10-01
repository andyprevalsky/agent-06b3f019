---
id: 2026-09-29-browser-payment-approved-request-omitted-from-verifier
date: 2026-09-29
title: Browser payment verifier lost the approved request after card issuance
surface: agents
component: spawn-browser-agent-v3 / payment approval resume and verifier evidence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py payment pause — request_payment_card returned before its result was recorded in action_history, the verifier's normal input"
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
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_recorded_payment_request_survives_verifier_action_window
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

Critical path: `request_payment_card` validated the order → the browser saved
its pending tool result in the model transcript → the activity returned before
recording the same result in `action_history` → card approval and mint resumed
the browser → the verifier read `action_history` and the existing last-four
card event, so it could not see the requested merchant and order → the browser
repeated `attempt_completion` and timed out. A request entry can also age out
of the verifier's bounded 30-action window.

The problem class is a cross-activity evidence contract gap. The existing
browser transcript contained the request, while the verifier consumed a
different store. The fix records the actual request result in both histories,
then resolves the pending result on card issuance. The verifier selects that
recorded request when later actions push it outside the 30-action tail. No
extra model turn or synthetic order summary is needed.

## Reproduction and verification

The first proposed repair carried a separate approved-order summary into
`payment_card_ready`; its tests passed, but it duplicated existing tool data.
That repair was removed after user review. The replacement regression checks
that the actual request result reaches the verifier after more than 30 later
actions. The full owning domain passed after this revision:

```text
cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py spawn-browser-agent-v3
Results: 1 passed, 0 failed (54.1s)
```

The exact unchanged benchmark has not yet been rerun on the fixed worker.
The parent deploy loop owns that full AgentCard gate. Keep this case open until
the benchmark passes with a working frontend link and record its run here.

## Solution

The payment pause now records the actual `request_payment_card` result in
`action_history`, which the verifier already consumes. On resume, the pending
tool result in both browser transcript and action history changes to approved,
with validated card last four and the names of available secret refs; secret
values are excluded. For older paused tasks whose action-history entry is
missing, the resume reconstructs it from the saved tool result. The verifier
includes that real entry if it falls outside the 30-action tail, alongside its
existing last-four issuance event.

The follow-up resume audit found a more serious context gap. The three real
browser pause paths had truncated provider-visible turns to the last 40,
replaced screenshots with placeholders, and shortened action history and URLs
to 30. Payment resume also inserted card instructions into the dynamic system
message. A dump of the failed payment run showed the system message changing
from 1,877 to 2,314 characters at resume, breaking the cached prefix.

Real browser pauses now preserve the prior provider transcript, including
screenshots, and the full action history and URLs. The saved transcript already
includes the original `request_payment_card` call and its awaiting-approval tool
result. When the real card mint completes, resume resolves that existing result
in place with its approved status, last four, and available secret-ref names.
No new browser user turn or duplicate tool call is introduced. Removing the payment-only
dynamic-system addition preserves the prompt prefix when the rest of the
runtime context is unchanged; a real credential/context change can still alter
the system message. Small snapshots travel inline in the Temporal activity result. Above
one million serialized bytes, the worker synchronously writes chunked AES-GCM
encrypted snapshots to the trace archive and verifies each read before
returning a pointer. Resume checks the full SHA-256 before continuing and fails
closed if any part is missing or changed. This avoids Temporal's 2 MiB payload
limit without silently discarding prompt context.

Browser handles and the live page are reconnected and reread. Current auth
options are reloaded from the session, while prior attempts for the same realm
are restored. Retry and recovery counters still reset at the activity boundary;
those are session-scoped control state rather than prior model messages. The
browser's in-run action-summary and verifier-checkpoint caps remain separate
from the pause serialization. The exact payment benchmark remains pending.

## Human feedback

The user asked what else the browser drops on resume and identified the prompt
cache loss. The follow-up change preserves the model-visible prefix and uses
verified external storage when it cannot fit in a workflow payload. The user
rejected added browser guidance and synthetic prompt turns; this revision uses
the saved tool result and normal verifier action history. The standing deploy
instruction forbids timeout, prompt, and evaluator changes for the benchmark
failure.

## Reusable lesson

Preserve completed browser turns across approval, resolve the original pending
tool result when the operation finishes, and give the verifier that recorded
result instead of an invented instruction or order summary.
