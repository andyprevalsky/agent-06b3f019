---
id: 2026-11-10-unretrieved-cdp-futures-during-local-release
date: 2026-11-10
title: Local CDP release exposed four unobserved command Futures without their registration identity
surface: agents
component: cdp-multiplexer-internal-future-ownership
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: asyncio reports an unobserved internal command Future after SessionManager reset and before local mux release completes
symptoms:
  - Future exception was never retrieved
  - CdpMultiplexerUpstreamClosed
  - provider CDP socket closed code 1000 reason released
tags:
  - browser
  - asyncio
  - cleanup
  - future
sources:
  - PR #1915
  - commit 009e97401550115295b42af9ef83be37bda55055
  - agent 58645954-6920-40bf-b36b-ddb041e21dcf
  - agent 5725ff28-94b0-458f-bbcb-358de77ac123
repro: not reproduced; exact command registration and awaiting owner absent from the native capture
status: open
---

## Problem

The original cloud smoke campaign recorded four unobserved Future exceptions
across the test-shop, setup-resume and new-user-journey tasks. All three native
task evaluators passed at their original deadlines. The exceptions occur after
SessionManager reset/disconnect and before local mux release and cleanup finish.
Native source, log indices and hashes are retained in the private deploy evidence.
No failed test was invented to qualify an independent repair handoff.

## Diagnosis

`_close_upstream` constructs the code 1000, reason released exception locally;
`_fail_internal` sets pending internal Future exceptions and clears their map.
This proves an unobserved Future diagnostic during local cleanup, rather than
an external provider outage. It does not prove that transport closure failed.
The native capture omits Future creation stacks, internal command IDs/methods
and awaiting Task identities, so the exact abandoned owner is unproven.

One concrete source lead is `_release_client` registering a detach Future and
passing it to `_reapply_overrides_after_detach`, which returns immediately when
there are no orphaned overrides. A partially issued emulation batch is another
possible lost-observer path. Neither is established as the cause of these four
runtime exceptions. Source parity between the base and SDK repair cannot prove
SDK causation without matched runtime dependency and command-order controls.
Attribution therefore remains UNKNOWN for this observation.

Archive searches and the actual historical mux retention repair and monitoring
threads were read. Their different proven boundaries do not establish current
ownership. Separately observed missing-element input/click errors recovered
through successful actions; the new-user credit pause matches its intentional
subscription fixture. Those facts do not resolve the Future ownership gap.

## Solution

No repair is claimed. Preserve the original task PASS grades and the diagnostic.
An owning reproduction must identify each pending command's registration,
creation stack and awaiting Task through reset/release, then prove the lost
observer and its correction without suppressing the original error. No source
instrumentation, new native run or speculative callback fix was introduced.
This durable open case retains the investigation gap; it supplies no waiver
for the separately assigned Playwright startup repair. Golden reference is not
applicable to this records-only observation.

## Human feedback

None recorded.

## Reusable lesson

A locally constructed release exception can expose a real Future ownership gap without proving an external outage or a failed task; retain the registration and awaiting owner before selecting a repair.
