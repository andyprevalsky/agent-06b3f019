---
id: 2026-11-03-tilion-chromium-readiness-empty-payload-unresolved
date: 2026-11-03
title: Tilion coverage Chromium readiness failed before browser attachment without a retained cause
surface: agents
component: browser-tilion-blackbox-fixture
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: raw full Chromium fixture returned no webSocketDebuggerUrl before yielding to the multiplexer test
symptoms:
  - "AssertionError: /json/version on 127.0.0.1:41131 -> {}"
  - multiplexer_arms_webauthn_popups
  - browser-tilion coverage domain failed
tags:
  - chromium
  - readiness
  - coverage
  - unresolved
sources:
  - commit 3a263f66706580232c84505666e3914b80153717
  - commit 3a94552828156ac2de594697f95f990006268ead
repro: cd agents && AGENTS_COVERAGE_CONCURRENCY=2 bash scripts/run-coverage.sh
status: open
---

## Problem

The required coverage blackbox gate on3a263f667 exited1 with123/124 domains
passing. browser-tilion failed after199.18s in the registered
multiplexer_arms_webauthn_popups case. The exact assertion above occurred at
browser_tilion.blackbox.py:147, entered from1491 through1458, before the raw
Chromium fixture yielded and before FakeTilionGateway or the multiplexer was
constructed. Native stderr was discarded and HTTPError probe details were not
retained. The original failed log is preserved privately with SHA256
7fb92edeb4d64ebeb8cbca8dfd28dc468bca6033345e42b62c7347512cbb79a5.

## Diagnosis

Gate: UNKNOWN against3a945528. The fixture, entire domain, multiplexer,
HTTP capture/case-reset utilities, test defaults, coverage runners and declared
dependencies are byte-identical. A real baseline archive executed the unchanged
registered function with its unchanged assertions and polling bounds, passing
in7.694s. Runtime tracing identified26 executed repository files, all identical
to the failed candidate; no changed production module was imported. Both owned
Chromium processes were reaped and temporary profiles removed.

This focused baseline control does not reproduce or erase the native failure.
It omits preceding same-domain state, coverage instrumentation and the original
host schedule. Two isolated coverage domain processes share host resources;
case functions within the Tilion domain are awaited sequentially. There is no
observed overlapping mock handler or retained evidence of resource starvation,
port ownership interference or a particular Chromium crash. The empty payload
can be the initial dictionary after all suppressed HTTPError probes, or a
successful empty JSON response. Native evidence cannot distinguish these.

Actual prior repair conversations about identical startup symptoms and a
different native-port startup failure were read in full/relevant scoped turns.
Their passing controls and unproven causes do not establish a matching landed
repair or source attribution here. The older WebAuthn document-service case
reaches browser attachment and fails later, so it is a distinct boundary.

## Solution

No source fix or attribution waiver is established. Preserve the original
failure and exact assertions/timeouts. A new complete test loop is independently
required by subsequently reproduced completion/pause fixes; its current-source
outcome must be recorded separately without rewriting this historical result.
Do not convert a passing focused repeat into native aggregate success. No
provider request, credential, quota, cooling or persistent account mutation was
needed for this diagnosis. The assigned Webdecoy lifecycle repair remains
owned by the implementation/deployment owner.

## Human feedback

Every actual failed gate requires evidence-backed RCA. UNKNOWN cannot receive
a delegation waiver. Unrelated filenames, possible resource pressure and a
passing baseline repeat do not establish NOT_INTRODUCED. Preserve test intent,
assertions, bounds and original native receipts; never manufacture a pass.

## Reusable lesson

An empty readiness payload without child stderr, exit state or probe outcomes
cannot distinguish startup, transport and response failures; retain uncertainty
instead of assigning a convenient environmental cause.
