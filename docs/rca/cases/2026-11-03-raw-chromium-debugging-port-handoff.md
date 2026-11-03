---
id: 2026-11-03-raw-chromium-debugging-port-handoff
date: 2026-11-03
title: Raw Chromium loses its debugging port between parent reservation and native listen
surface: agents
component: browser-tilion-chromium-readiness
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Native Chromium IPv4 bind returns EADDRINUSE after the parent closes its reservation; Chromium listens on IPv6 while fixture readiness probes IPv4
symptoms:
  - "AssertionError: /json/version on 127.0.0.1"
  - "bind() failed: Address already in use (98)"
  - raw full Chromium remains alive with an IPv6 DevTools listener while IPv4 readiness exhausts all 100 attempts
tags:
  - chromium
  - browser-tilion
  - readiness
  - port-ownership
  - native-contention
sources:
  - commit c36b3c3e0c82c5801c201e031aeda162e6499dbe
  - commit 1b3d72ff19727804bc29dc1a4568abd2aa8a59f0
  - agent ph75kv9gt1qe03a56njqm2md558hg98j
  - task 01a19ee8-8593-7321-b8e6-673e22f7698c
repro: cd agents && AGENTS_COVERAGE_CONCURRENCY=2 bash scripts/run-coverage.sh
status: fixed
---

## Problem

The assigned retained browser-tilion failure is in
`test_multiplexer_arms_webauthn_so_unarmed_popups_reject_instead_of_hanging`.
Its unarmed branch enters `_chromium(full=True)` and fails the original local
`/json/version` readiness assertion before the fake Tilion gateway or multiplexer
is constructed. The retained source is `e5106827bdd153b1fdc1d0f134d9aa33e5f05d68`,
merged in PR #1668 as `cf8bc97262fb069b615bbdd17e18dfb206649b33`.

The original 123-pass/1-fail/124-domain aggregate and source/support packet remain
unchanged privately. Its archive SHA256 is
`ac0721b302d0154f8442177017c580d95600acdb32f632c4152a703f1669d679`.
The exact historical cause remains UNKNOWN: original child stderr, exit and probe
history were not retained. The printed `{}` is the initial accumulator after
suppressed HTTP exceptions, not proof of an HTTP response body. The independently
established introduction-only NOT_INTRODUCED attribution does not release this
assigned repair.

This case diagnoses a NEW naturally observed owning startup defect with the same
readiness assertion. It is distinct from the archived popup document-service
`NotSupportedError` after startup, PR #1663's provider contract, and PR #1669's
telemetry cancellation ownership fence during disconnect.

## Diagnosis

Critical path: parent binds an ephemeral IPv4 socket -> closes it -> creates a
private profile -> raw full Chromium starts with that now-unowned port number ->
native socket bind -> IPv4 `/json/version` requests -> original readiness
assertion -> caller. A closed reservation is a number, not an ownership transfer.

Clean controls did not prove a repair: unchanged full canonical coverage passed,
1,000 isolated native starts passed, and two instrumented complete canonical runs
passed all 124 domains plus 214 DEMO and 176 unit tests at 85% coverage. None had a
behavioral startup fix. Reduced diagnostics did not replace full acceptance.

A later cohort ran four independent processes calling the real owning helper
with its original browser arguments, real Popen/HTTP, all 100 attempts and 0.1s
sleeps. No port, response, native error or delay was injected. It stopped between
attempts on a natural failure, retaining 5,524 successful startups and one failed
startup (5,525 total); these stopped-cohort counts are not a failure-rate estimate.
The sealed native packet SHA256 is
`8834d01496493e32ad6855ae0e9f157fec2fcbe15f8cadfeab727b2a9471ec39`.
It contains exact native stderr, metadata, all lane manifests/results/timelines,
the failed native console and measured source/binary bindings. Temporary capture
preserved all 372 original assertions and all original launcher/poll/cleanup bounds;
it was removed before the permanent regression and repair.

The NEW failed child 2308865 reports actual native IPv4 `bind()` errno 98 at
2026-11-03 02:08:00.430171 UTC, announces an IPv6 DevTools endpoint, and remains
alive through all 100 failed IPv4 probes (99 ConnectError, one RemoteProtocolError).
No decoded response replaces the empty accumulator. The pre-cleanup snapshot has
an IPv6 LISTEN row; native poll is still alive. The subsequent -9 is the fixture's
expected kill, not a spontaneous crash. Another cohort child, 2308797, naturally
selected the same released port, announced IPv4 and returned genuine DevTools JSON
in the overlapping startup interval.

The exact competing kernel inode/PID at the failed bind was not sampled. The
same-port winner corroborates contention but is not a fabricated syscall receipt.
The late TIME_WAIT row does not prove it caused the bind failure; the
RemoteProtocolError's actual peer is unknown. A separate passive process observer
started after the cohort ended and captured zero native events, so it is excluded
from causal evidence. These limitations do not erase the positive native
EADDRINUSE, IPv6 listener, live child and exhausted IPv4 readiness observations.

Step 5: What: a live raw browser cannot satisfy the fixture's IPv4 readiness
contract. Where: the first observed native failure is IPv4 bind errno 98, before
any gateway/multiplexer/WebAuthn construction. Why: the parent releases a selected
port before Chromium owns it; native fallback can produce an IPv6-only listener
which the fixture never probes. Proof: the unforced native packet plus the
controlled real-kernel regression below. Problem: invalid allocation-ownership
contract in the fixture, not an insufficient polling timeout or established OOM.

Primary Chromium 153.0.8010.12 sources agree with the native observations:
`chrome/browser/devtools/remote_debugging_server.cc`'s ordinary CLI factory tries
127.0.0.1 and then ::1 on the requested port. Its free-port fallback factory belongs
to approval mode, not this CLI launch. For requested port zero, that source selects
the private user profile as the discovery output directory.
`content/browser/devtools/devtools_http_handler.cc` obtains the actual listening
address and writes selected port plus browser-specific path to DevToolsActivePort.
The source does not promise atomic file publication or file-only HTTP readiness.

## Solution

The repair lets full raw Chromium request port zero. The kernel
allocates the listening port during Chromium's own bind. The fixture discovers
both port and browser path from THIS launch's fresh private profile, performs the
original real IPv4 HTTP GET and unchanged readiness assertion, then checks that
the returned endpoint path matches the browser's own publication. Missing/partial
discovery consumes the SAME original 100-iteration budget and existing sleeps;
there is no separate discovery wait or timeout increase. Existing raw browser
flags, no-extra-CDP-client launch semantics, caller assertions and cleanup bounds
remain. This addresses the observed ownership defect class; it does not reconstruct
the lost historical event or guarantee success under every unrelated native failure.

The permanent registered `raw_chromium_port_handoff` regression coordinates a REAL
bound non-listening IPv4 socket at the old reservation/Popen handoff, delegates
the actual original Popen arguments, and keeps the competitor bound throughout
readiness and a real CDP Browser.getVersion reply. It fabricates no browser, errno,
HTTP response or CDP result. It is deliberately CONTROLLED native contention,
not another natural occurrence or a reconstruction of the historical scheduling.
It does not replace the separately retained unforced RED or original full command.
Its placement preserves the existing WebAuthn case as the first full-build launch.

Before repair, commit `c36b3c3e0c82c5801c201e031aeda162e6499dbe` retains an AST-identical
original launcher. The unchanged full command exits 1 after running all 124 domains
(123 pass/one browser-tilion domain fail). All 58 original domain cases pass,
including the assigned WebAuthn case; the added regression fails the ORIGINAL
readiness assertion with actual native errno 98 and IPv6 fallback. The script
stops before downstream pytest/threshold enforcement, so those are not reported
as passed for this RED run. Exact artifacts are retained privately under
`.context/chromium-readiness/controlled-native-red/`.

The branch was rebased over two factory-ledger-only main commits; the before
fixture bytes remain identical. Repair commit
`1b3d72ff19727804bc29dc1a4568abd2aa8a59f0` preserves the identical permanent regression
and all 377 preceding assertion ASTs (372 original plus five regression assertions),
and adds one endpoint-identity assertion. The identical complete post-repair canonical command exits 0: all 124 domains
pass, including the assigned WebAuthn case and unchanged native contention
regression; all 214 DEMO tests and 176 unit tests pass, and the configured
coverage threshold passes at 85%. The native command ran with TMPDIR=/var/tmp
and CODEX_AUTH_PATH absent process-locally. Exact aggregate, domain and full
command artifacts are retained under
`.context/test-runs/agents-coverage-20261103-023722-2656198/` and the private
GREEN receipt binds their hashes. This verifies the startup repair; deployment
review, merge and production verification are tracked separately.

## Human feedback

The user requires this assigned startup repair through its own completed deploy,
with the original full command, complete current catalog, DEMO/unit pytest and
coverage threshold. Attribution and clean reruns cannot waive it. Preserve all
assertions, timeouts and real-browser coverage; no synthetic accepted boundary
outputs, filtered acceptance, account-agent flag changes or old provider sessions.
Preserve Freedom and protected instructions. No human acknowledgement is needed
for the already authorized repair, normal gates, merge and verification.

## Reusable lesson

Transfer ownership through the resource owner, not a closed preflight reservation.
Discover a raw browser's own published address and still verify the real service
and identity under the original readiness budget. Retain native stderr and
pre-cleanup state before killing a failed child. Distinguish a new observed native
mechanism, controlled causal regression, final full acceptance and completed
deployment from an unrecoverable historical exact cause.
