---
id: 2026-08-26-browser-benchmark-timeout-batch-aug25
date: 2026-08-26
title: Post-sync browser bench 2/7 — agents timed out before checkout attention gates
surface: harness
component: browser-benchmark-suite
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: execute-phase root agents for amazon/doordash/event-ticket/imax/tinypng — browser sub-agents exhausted dynamic timeout caps without triggering write_lock or payment_approval evaluators
symptoms:
  - "Timeout after 903s (dynamic cap=900s)"
  - "Expected write_lock attention request (to ignore) but none was triggered"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "INFINITE LOOP: message repeated Browser state captured."
tags:
  - browser
  - benchmark
  - timeout
  - write-lock
  - payment-approval
  - read-browser-state
sources:
  - agent 673f5099-05ba-492b-8f78-6c1855d5c12b
  - agent c963e2c0-41e2-4686-8015-ee94969a900a
  - agent 21a308f5-4a31-41d7-b98a-2c0c005ce945
  - agent aad61420-3982-463b-871b-1b42fbc20050
  - agent 45f3eb68-a3e1-4f7d-8cc3-6c0a8f8960b1
repro: none-recorded — outcome repro is the full live benchmark task (600–900s); no smaller owning-boundary test isolates checkout flake
status: open
---

## Problem

After sync + `UnboundLocalError` fix (`214d105a9`), post-sync rerun of seven
browser benchmarks scored **2/7** (eventim + alchemy pass; five timeout fails).
Run JSON: `20260825_201643_*.json`.

| Task | Result | Failure |
|------|--------|---------|
| browser-1015-eventim-request-card | PASS | — |
| browser-alchemy-springs-sauna | PASS | — |
| browser-amazon-return | FAIL | timeout 666s; no write_lock |
| browser-doordash-usb-c-cable | FAIL | timeout 903s; no write_lock |
| browser-event-ticket | FAIL | timeout 904s; no payment_approval |
| browser-file-upload-tinypng | FAIL | timeout 604s; ACTIVE not COMPLETED |
| browser-imax-group-tickets | FAIL | timeout 903s; no payment_approval |

Same branch scored 6/7 pre-sync (only eventim failed on max-steps/no payment card).
This batch is **not** the `UnboundLocalError` regression (fixed separately).

## Diagnosis

Evidence from `agent_logs.py --tree --diagnostics` and run message transcripts:

1. **Amazon (`673f5099`)**: 20 `read_browser_state` actions; stuck navigating
   return UI ("Evaluating indexes"); 484–1281s LLM stalls; never reached Amazon
   return confirmation write_lock. Related prior case:
   `2026-08-21-amazon-return-k5-switch-accounts-on-remembered-signin` (Switch
   accounts misroute) — this run's transcript shows index/evaluate confusion, not
   the same Switch-accounts signature.

2. **DoorDash (`c963e2c0`)**: `Element with index 267 not found`; 300s message gap;
   searched delivery options without completing checkout write_lock.

3. **Event ticket (`21a308f5`)**: scrolled AMC showtimes, repeated
   `read_browser_state` / evaluate JS; never reached payment_approval.

4. **TinyPNG (`aad61420`)**: only 3 `read_browser_state`; **484s stall** between
   messages 19–20; never COMPLETED upload/compress flow.

5. **IMAX (`45f3eb68`)**: 25 `read_browser_state`; timed out before payment_approval.

`read_browser_state` call counts do **not** separate pass vs fail (alchemy pass
used 22 reads; tinypng fail used 3). Failures are heterogeneous agent navigation /
completion stalls, not a uniform harness bug.

Worker logs show Claude 429 `rate_limit` at bench start with waterfall fallback
to OpenRouter — both passing and failing tasks hit this; not a single-task isolate.

First-bad boundary: each root agent's execute loop — browser sub-agent never
surfaced the evaluator's expected attention request before the dynamic timeout cap.

## Solution

No code fix landed in this RCA. The deterministic crash (`UnboundLocalError`) was
fixed in `214d105a9`. Remaining failures are open **model/task flake** on live
checkout benches; rerunning individual tasks is the valid verification path.

Do **not** raise benchmark timeouts as a workaround (rule 25). If a task class
recurs, consider orchestration hints or eval contract review — not prompt nudges
for empty-shell payment deferral (rejected in prior eventim cases).

## Human feedback

None recorded.

## Reusable lesson

When a browser bench batch regresses after a harness refactor, separate
deterministic crashes (instant activity failure, action_count=0) from timeout
flakes (no attention gate) before attributing all failures to the refactor.
