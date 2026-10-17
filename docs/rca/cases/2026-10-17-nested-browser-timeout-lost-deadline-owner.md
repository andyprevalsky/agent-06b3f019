---
id: 2026-10-17-nested-browser-timeout-lost-deadline-owner
date: 2026-10-17
title: Nested browser timeout lost its actual deadline owner
surface: agents
component: spawn-browser-agent-v3-evaluate-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handler action TimeoutError catch reported the configured outer330s for an actual inner15s expiry
symptoms:
  - "Browser evaluate timed out waiting for Runtime.evaluate"
  - "Browser action 'evaluate' timed out after 330s; generic browser supervisor recovery ran."
  - "Observed tool failure: spawn_browser_agent call_18cbko6jt0hIMHZZTXY2gDx1 status=ERROR"
  - "foreign transport timeout acquired local deadline ownership"
tags:
  - browser-agent
  - evaluate
  - nested-timeout
  - deadline-ownership
sources:
  - commit cdf9209f69eabfde10d77e8f831845a07411ee95
  - agent b533807b-8bba-4376-b2ab-fb86d1dcf818
  - plan:.context/auth-deploy/repair-native-six-cdf9209-20261016-2335/human-signin-error-rca/timeout-owner/origin-v2-review.md
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_nested_action_timeout_keeps_actual_deadline_owner (registered browser blackbox)
status: open
---

## Problem

Original unchanged SIX human-signin task FAILED897.4s: its strict evaluator
observed the real child evaluate ERROR call_18cbko6jt0hIMHZZTXY2gDx1. Worker
38151 measures eval_ms15001, timeout_s15.0, session_acquire_ms64 at23:55:15.897135;
worker38249 falsely reports330s at23:55:19.046396. This case concerns diagnostic
ownership, not permission to erase that genuine failure. Later accepted handoff,
USER sign-in, full-credit final verifier and root COMPLETED are counterevidence
to “no assistance/no completion,” not grounds to waive no_tool_failures.

## Diagnosis

Step28 captured292-character async same-origin fetch awaits both response and
body. The existing inner evaluate deadline expired; responsive browser/renderer
probes led to generic recovery. handler caught its TimeoutError and substituted
the outer configured330seconds. Actual matching-path backend GET200/duration0ms
at23:55:01.091 is strong temporal/path correspondence, but lacks exact browser
request/response correlation; underlying CDP/tunnel/promise stall remains OPEN.

Two archive searches are retained as timeout-owner/archive-search-{1,2}.log:
`evaluate timeout outer supervisor` and `nested deadline ownership timeout reporting`.
Solution and Human feedback were read in
[the inner-CDP-bound case](2026-08-22-evaluate-cdp-await-unbounded-burns-task-budget.md)
and [hard-recovery evaluator case](2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures.md).
These are distinct boundaries: the inner bound actually worked here, and current
generic recovery is not the archived frozen-renderer exemption. No duplicate
nested-origin reporting case was identified. Process feedback forbids cap bumps,
unproved network causes and theory-only closure.

C+1 nested-deadline producer/consumer ownership is coherent: retain the deadline
that actually expired across a supervisor. It covers inner/outer/foreign timeout
siblings without semantic success labels. No prompt proposal or fabricated
Step5b failed-coherence claim is made.

## Solution

Reviewed patch ca20b8a04e2f2b189f69f2ded8a4bed36c07f88f01a58bc15e49afd61225b978
uses asyncio.timeout.expired() to establish actual inner ownership before raising
a tiny typed duration/elapsed carrier. Existing outer wait_for retains its own
task; normal deadline cancellation reports330. Untyped noncancelled child errors
report unknown origin and the configured cap separately. Cancellation-suppressing
foreign exceptions can conservatively remain unknown. Failure, cleanup, caps,
evaluator and replay behavior are unchanged.

Predecessor5369adbc wrongly wrapped an immediate CDP TimeoutError as local expiry;
root review BLOCKED it. The actual foreign-timeout negative failed that version;
corrected candidate passes it, inner expiry, real outer cancellation, untyped
unknown, cancel/seal and existing bound controls. Same real execute_action feeds
the actual handler catch AST with external seams faked. Original3304 assertion
ASTs retained;3316 total. Only predecessor-added untyped=330 expectation was
corrected. Selected RED/GREEN logs and exact full795PASS/0FAIL log are retained;
six socket attempts were denied, zero transmitted through guarded entrypoints.
This is not an OS-wide/subprocess network audit or a new canonical/native proof.
Source hashes/applycheck passed; the private proof left CDF unchanged. This checkpoint adopts the reviewed reporting correction. Predecessor and invocation
failures remain preserved, never relabeled.

SIX actual5PASS/1FAIL remains unchanged. The parent verified all seven roots in release proof
`d9a7c125d7db5676952ced9a0b80aedd76fc61f37d56382d94cd5c8eb1cc5902`,
with genuine native history appends preserved. All six primary agents received
fresh durable FE/recording and HTTPS dump checks; the extra fixture remains
separate ungraded resource custody. These do not alter native grades. Terminal-policy prototype is
stopped/unadopted. No all-class elimination or strict native repair claim.
Functional checkpoint/normal original30 continuation is parent-owned, not a
waiver of the six-run failure or authority to alter task/model/deadline/evaluator.

## Human feedback

User: “dont ask me to aprove prompt changes unless they prove it passes, u only
need approval at the deploy step”. This reporting-only draft requests no approval.
Root required preserving genuine child ERROR and rejected the5369 foreign-timeout
misclassification; no generic recovery exemption or timeout increase is allowed.
Freedom and protected instructions remain untouched.

## Reusable lesson

Carry proven deadline ownership across nested timeout boundaries and report unknown origin honestly instead of substituting a configured outer cap.
