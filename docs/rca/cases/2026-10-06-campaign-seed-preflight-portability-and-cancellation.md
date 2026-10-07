---
id: 2026-10-06-campaign-seed-preflight-portability-and-cancellation
date: 2026-10-06
title: Owned campaign seed preflight required optional Python packages and ignored cancellation
surface: harness
component: cloudbench-campaign-seed
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fixture unconditionally imports dotenv and the campaign blocks in an uninterruptible seed subprocess wait
symptoms:
  - ModuleNotFoundError for dotenv in system Python
  - expired existing startup deadline accepts a complete canonical fixture GET
  - campaign SIGTERM leaves its full GET running until the transfer ends
tags:
  - cloudbench
  - seed-preflight
  - cancellation
  - process-ownership
sources:
  - commit 93dea65a7a5b2f6ad0612838efedf8671101d011
  - agent /root/independent_daily50_control
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: mitigated
---

## Problem

Three owning controls failed on unchanged source: system Python without optional
site packages could not bind the fixture; an already expired startup deadline
still performed and accepted the real TypeScript client's loopback GET; and
SIGTERM to the real campaign left its owned preflight blocked until the fixture
was manually released. The exact final three tests failed in 20.52 seconds on
the original source and passed on the candidate. These are preflight defects,
not evidence that they caused any earlier production fleet failure.

## Diagnosis

Strict campaign parent → fixture identity → complete seed GET → receipt → child
admission is the path. The parent already owns cancellation, inventory identity
and startup scope, but its synchronous subprocess wait could not observe those
changes. The seed helper accepted a deadline argument without enforcing it for
prepare/standalone GET, and required an optional library in system Python.
Archive searches found the earlier repeated-canonical-GET case; this is a new
boundary in the same owning module, not proof of its historical startup timing.

Independent runtime review caught two draft defects: polling reaped the GET
leader before descendant cleanup, and cancellation during payload hashing could
still return accepted proof. Both were reproduced with harmless local processes
and no provider or model requests; the owned fixture processes were cleaned.

## Solution

Retain the installed dotenv parser when available. Without that optional
package, reuse the existing minimal env parsing behavior for the four selector
keys, then let injected environment values take precedence. No credential
contents or hashes of secret values enter the receipt.

Poll the existing campaign cancellation and inventory authority while waiting
for its seed helper. Reuse the existing generous startup budget, with no new
per-attempt GET timeout. Run only that host GET in its own process session,
retain the waitable leader until its session drains, and bind later descendant
escalation to native birth identities. Cancellation gets a 120-second cleanup
grace; completed hashing and final return both fence cancellation/deadline
changes. Unavailable native process observations warn and retry within that
same startup budget. Only completed, current owned transfers may publish proof or admit
controllers. The existing full GET, payload hash, cohort/source/storage binding
and standalone transfer remain intact. Task prompts, models, evaluators,
execution defaults and production runtime behavior are unchanged.

The three original controls and the existing owning family are registered via
`campaign_inventory` in `scripts/tests/benchmark-live-results.test.py`; the
normal deploy structural gate discovers them. Independent review reproduced
both draft boundaries, made the unchanged two controls pass, and reviewed the
final source. The complete registered family passed 15 cases with one Linux-only
skip in 27.96 seconds on the final source. Exact commands, source and test hashes
and private RED/GREEN records are retained under the owning private seed-repair
directory. Integration and final cloud proof remain separate obligations; no
LIVE fleet result or historical production root cause is claimed here.

## Human feedback

The user required generous stage budgets, warned against narrow assertion and
timeout gates, and required quick owning tests in the normal deploy process.
This repair uses the existing stage budget and exact cancellation ownership,
without tightening benchmark acceptance or adding synthetic model work.

## Reusable lesson

A shared preflight must observe its existing owner's cancellation, drain all
owned children before returning, and publish proof only after complete work.
