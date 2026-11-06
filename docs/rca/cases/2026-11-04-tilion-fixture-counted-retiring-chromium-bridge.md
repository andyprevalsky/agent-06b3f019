---
id: 2026-11-04-tilion-fixture-counted-retiring-chromium-bridge
date: 2026-11-04
title: Fake Tilion gateway counted a closed client while its Chromium bridge retired
surface: agents
component: browser-tilion-fake-gateway-slot-accounting
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A controlled real transport reaches CLOSED while FakeTilionGateway.active remains one until the separate Chromium bridge context finishes
symptoms:
  - "AssertionError: round 1: slot not released"
  - "AssertionError: native test left an upstream client"
  - "closed socket counted during bridge retirement, CLOSED, 1"
tags:
  - tilion
  - cdp
  - fixture-lifetime
  - transport-ownership
sources:
  - PR #1662
  - commit 978c0cfe808f96281620d562ed2ba0cc8c163f87
  - commit 4a2aae4bd4274a1d3a140063fb6d2b5543b8a31b
  - agent ph74hwnjjn92y5dkttwnv6v8c98hf19y
  - plan:.context/deploy-pipeline-successor/attempts/41/triage/agents-coverage-blackbox
repro: agents/tests/blackbox/browser_tilion.blackbox.py
status: open
---

## Problem

Source978c phase41 preserves123 passing agent domains and one failed
browser-tilion domain. The pause test failed at its final gateway.active zero
assertion; the reconnect test failed the same invariant after its original0.2s
sleep in round1. WebAuthn passed. The aggregate remains UNVERIFIED/native1;
this private candidate does not rewrite its receipt or claim full acceptance.

The original log is the browser-tilion.log under
agents-coverage-20261104-071328-3957434 in the prepared agents worker. Its native
transport/handler-finally state was not captured at either failed assertion.
Whole-occurrence source attribution therefore remains UNKNOWN.

## Diagnosis

Path: local CDP clients disconnect -> production multiplexer releases its
provider-facing WebSocket -> fake gateway finishes its forwarding tasks ->
separate Chromium-facing context closes -> gateway counter decrements -> test
reads the counter. The counter measured the bridge-handler lifetime rather than
the accepted provider-facing socket lifetime.

The new registered regression uses actual loopback WebSockets and holds only
the browser-side context retirement after the client socket has truly closed.
The original fixture fails with the literal tuple
`('closed socket counted during bridge retirement', 'CLOSED', 1)`.
No close ACK, counter, expected result, budget or packet is fabricated. The
same command and regression pass after moving retirement to the accepted
connection's native connection_lost callback.

The regression first keeps a real client OPEN, asserts it is counted, and
requires an actual concurrent second client to close with4409. It then confirms
the first native transport CLOSED, checks zero active slots while old browser
cleanup is held, and reconnects successfully. A separate control deliberately
holds the actual production mux upstream open: the unchanged original round1
assertion still fails, with a native OPEN socket and active1. Thus this
correction does not excuse an actual retained upstream.

One unchanged original two-function diagnostic passed before correction
(pause51.728s, reconnect2.127s). Candidate originals also passed
(pause53.526s, reconnect2.187s). Those green observations alone prove neither
the historical cause nor a repair. Only the controlled RED/GREEN proves the
fixture defect; missing original close-state evidence remains an explicit gap.

The producer mux file has no diff between4a2 and978c. Both failed function ASTs
and FakeTilionGateway's original AST are identical across those revisions.
This conditional parity is not a claim that the full PR or original occurrence
is NOT_INTRODUCED.

Archive searches used the two literal assertions and behavioral
gateway/multiplexer/active/close terms. There was no exact prior counter case.
The October15 recording server-handler counter case is a related measurement
contract; the October28 pause checkpoint case owns an earlier transport handoff
dependency cycle. Their Solution and Human feedback were read; neither is
adopted as this incident's diagnosis. The separate raw Chromium readiness case
does not explain these assertions.

## Solution

Private test-only V2 candidateb49a9d86efd140bbc2ba7da63d58feecf0fb61d1c2e388bd6d333466a299fc3a
retires accepted slot membership/count from the real ServerConnection
connection_lost event and explicitly closes the downstream in handler finally.
Chromium-side retirement can complete independently. The existing owning domain
registers the two controlled regressions. No production code, timeout, retry,
provider behavior or original acceptance assertion changes. All393 original
assertions and both failed function bodies remain; fourteen assertions are added.

This unifies slot retirement with the actual owning transport without another
timer, polling loop, background cleanup task or production fallback. Other forwarding gateway subclasses retain their original bodies and counters.
HeldSlotGateway uses the same synchronous slot-retirement hook to begin its
existing post-disconnect hold before the counter is freed. Rejected nonmember
connections cannot restart that hold; bridge-handler return cannot restart it.
Golden reference: not applicable (no approval-gated hunk).

## Verification

Identical causal command: `python3 /var/tmp/pr1662-41-mux-fixture-repro/repro.py`.
Original fixture SHA0c5cca97c928e33dd121782243c2f81ac2a266bdab56d8294a0fec6fee44a1f1
returned1 in1.840s; corrected fixture
0338a8c4275a8bc2e3830afef1c22dc42043553def4fa5680de28b1477ccf59d
returned0 in0.713s. The regression source and native caller were unchanged.
The separate retained-mux control returned0 only after observing the expected
original assertion rejection and the native OPEN/active1 witness.

Independent review caught a V1 compatibility gap: the base callback freed its
count before HeldSlotGateway's old handler-finally began the configured hold.
A second actual loopback regression held browser retirement, closed the native
client, then reconnected. V1 failed with `held slot reopened during bridge
retirement`; V2 passed the identical command and regression by setting the
hold synchronously in the slot-retirement hook. This also verifies a rejected
client cannot restart the hold. The original late-free redial and busy-slot
backoff functions remain unchanged and passed on V2, as did the base regression
and the genuine retained-mux negative (native OPEN/active1).

V2 causal command: `python3 /var/tmp/pr1662-41-mux-fixture-v2/repro.py`.
V1 plus the new held regression (SHAad269ab7d431e759f9a43e8258efee4762f401c069a4e9a190092b885aac7bc4)
returned1; V2 (SHA70689265146f9cff9bd6744f8937984eb2e5bdffefc249f0b8ade9b930e34b6f)
returned0. The four final controls use the existing native supervisor and exact
worker root admission guard. No full domain/gate was run.

Private packet: /var/tmp/pr1662-41-mux-fixture-v2/report.json. Eight valid
native operations have quiescent existing supervisor receipts and no remaining
children. Source/configs and original phase41 evidence remain unchanged.
An initial private observer staging/missing-file failure executed no test
functions and is preserved separately, excluded from causal proof.

Independent review CLEAR binds exact V2 patch b49a9d86 and review
e021d7ddcd6bb388b13f30bf43bada101c0298fc629a0cac8c5115af156d5548.
The parent integrated that exact fixture correction; full owning domain and
gate acceptance remain pending. No native full-gate, benchmark or deploy PASS
is claimed; this case stays OPEN until those boundaries are satisfied.

## Human feedback

None recorded. The parent required unchanged sleeps, timeouts and assertions,
actual socket-state evidence, and a genuinely retained-upstream negative.
These are coordinator constraints, not attributed to the end user.

## Reusable lesson

Count a single-client slot at actual transport ownership loss, and prove the oracle still rejects a genuinely open client instead of counting delayed relay-handler retirement.
