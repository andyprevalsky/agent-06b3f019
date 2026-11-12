---
id: 2026-11-11-live-latency-ratchet-judged-one-provider-sample
date: 2026-11-11
title: The live Cerebras chat latency ratchet failed the gate on one 23.6 s provider sample
surface: back-end
component: cerebras-blackbox
classification: test-bug
problem_class: other
first_bad_boundary: back-end/src/tests/blackbox/cerebras.blackbox.ts live chat probe — asserted probe.elapsedMs < 5000 on a single unbounded live request, so one provider/network tail sample was attributed to the configured chat model
symptoms:
  - "AssertionError [ERR_ASSERTION]: chat model probe must stay under the lifecycle ratchet (23593ms)"
  - backend-coverage-blackbox blackbox:cerebras FLAKY on a Blacksmith gate VM, rerun passed
  - "FLAKY d2ba002c"
tags:
  - cerebras
  - latency-ratchet
  - live-probe
  - flaky
  - deploy-gate
sources:
  - PR #1932 (quarantine marker pending-handoff:d2ba002c0abd4af6a10da8c847d6ec2c)
  - commit 668964a473074ffb111f930523335ecf9f31d913 (failed source)
  - task backend-coverage-blackbox gate run 43041365615 (blackbox:cerebras)
  - PR #1954
  - commit 36700b227ae8f953a472408421e64ba07e710477 (merge, production verified)
repro: back-end/src/tests/blackbox/cerebras.latency.cases.ts
status: fixed
---

## Problem

On the PR #1932 deploy, `cd back-end && bash scripts/run-blackbox-tests.sh cerebras`
failed in backend-coverage-blackbox on a Blacksmith gate VM with
`chat model probe must stay under the lifecycle ratchet (23593ms)`. The automatic
rerun on the same source passed. Inventory, 404 and 2xx assertions all passed;
only the latency ratchet failed. The originating deploy quarantined it as
NOT_INTRODUCED. The earlier Blacksmith artifact in the R2 gate channel
(`backend-coverage-blackbox-b6b7f322a7832c0b`, 2026-11-09) records the same probe
at 173ms; devbox runs measure 145–300ms, with Cerebras `time_info.total_time`
about 15ms. Production logged no Cerebras incident for 11-11. It did log 429 bursts
on the shared org key at 15:29–15:34Z, which the chat hedge absorbed.
Neither the GitHub job log nor the artifact for run 43041365615 could be downloaded:
GitHub returned HTTP 502 for every artifact download. The R2 channel copy was
already collected. Even with them, the probe printed no response body, Cerebras
queue time or request id for a slow pass, so the tail cannot be attributed to
provider queueing versus network.

## Diagnosis

The ratchet exists to keep the configured chat model and effort fast enough for
the 5s FE lifecycle (`cerebrasRoute.ts`: "Effort `low` keeps first visible
content inside the 5s FE lifecycle ratchet"). It is not meant to bound one HTTP round
trip. Production never waits on a single slow Cerebras request. Chat starts the
OpenRouter hedge after 800ms (`DEFAULT_CEREBRAS_CHAT_HEDGE_MS`) and abandons
Cerebras at its 8s idle guard. The test took one unbounded live sample and treated
its elapsed time as the model's latency. Any single provider queue or network tail
therefore failed the deploy gate, even though the property under test held.

Local reproduction at the owned boundary: a `--import` preload
(`.context/rca-cerebras/d2ba002c/repro/delay-cerebras-chat.mjs`) delays the first
live chat POST before forwarding the real request. With the failed-source test
bytes (668964a) and `CEREBRAS_REPLAY_DELAYS_MS=23593`, the unchanged
`bash scripts/run-blackbox-tests.sh cerebras` failed with
`chat model probe must stay under the lifecycle ratchet (23810ms)`. With no delay,
the same command passed in 1176ms.

## Solution

`cerebras.latency.cases.ts` takes 3 sequential live probes. Each probe keeps the
existing 429/402/queue_exceeded retry policy, and sampling stops at the first
non-2xx so the 404, quota and 2xx assertions behave as before. The ratchet
asserts the **median** against the unchanged 5000ms bound and keeps its message.
Each sample's elapsed time, Cerebras `time_info.queue_time` and `x-request-id` are
printed and included in the assertion, which closes the attribution gap. The
d2ba002c quarantine marker is removed.

A hermetic regression runs on every invocation, including keyless ones:
[23593,150,156] passes, [6000,150,5000] fails with the ratchet message, a partial
sample set cannot pass, and sampling stops on a 404. Verification with the
identical command:

- 23593ms tail replay: PASS.
- 6000ms×3 replay: FAIL, `(6186ms median of …)`, so persistent slowness is
  still caught.
- No delay: PASS.
- Five consecutive clean runs: PASS.

The cost is two extra 8-token requests per gate run, with no production code
change and no effect at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Judge a live third-party latency ratchet on a small median of probes with
attributable per-sample timing, never on one unbounded sample, and keep the bound
itself unchanged.
