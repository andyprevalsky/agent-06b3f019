---
id: 2026-10-16-invalid-response-fixture-assumed-delivery-before-deadline
date: 2026-10-16
title: Invalid-response fixture counted requests before establishing response delivery
surface: harness
component: evidence-publisher-browser-validation-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: malformed and forbidden socket fixtures assumed the invalid response arrived before the unchanged 100ms transport timeout
symptoms:
  - "AssertionError: ('malformed', ['BenchmarkShare fixture.signature', 'BenchmarkShare fixture.signature'])"
  - expected one request but observed two while verify_agent_reachable failed closed
tags:
  - evidence
  - test-fixture
  - transport-timeout
  - invalid-response
sources:
  - PR #1518 development qualification
  - commit 11dd68fc7387738f4c69e516708b37bf30cfb3b3
  - commit 07984d3e7
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

The fresh deployment structural gate failed the malformed-response request-count
assertion: two authenticated requests were observed instead of one. The production
verifier returned failure as required. This is a fixture defect, not evidence that
production retried an already-observed JSON error.

## Diagnosis

Critical path: local HTTP fixture scheduling → socket headers/body delivery →
100ms urllib deadline → production timeout classification/retry → JSON parsing →
fixture request-count assertion. The first bad assumption was that the malformed
or HTTP 403 response necessarily arrived before the transport deadline. A timeout
before delivery legitimately permits one fresh read-only request; an invalid
response after delivery must never retry.

A controlled local replay ran the entire original fixture at exact source
`11dd68f`, delaying only the first malformed response's headers by 150ms. The
unchanged 100ms caller deadline expired first. The replay failed the exact
reported assertion with two `BenchmarkShare fixture.signature` requests. The
same replay command passes after isolating invalid-response delivery:

`/home/boxes/rose/agents/venv/bin/python /home/boxes/rose/.context/evidence-fixture-causal-20261016.py`

Raw before/after logs and the causal driver are retained beside that driver. This
is an explicit transport-delay injection; it reproduces the observed boundary
and does not claim to identify which scheduler delay occurred in the original
qualification run. An initial system-Python setup attempt lacked `markdown_it`;
it supplies no causal credit. The causal pair uses the existing agents venv after
an exact requirements-file comparison.

Archive searches used `malformed BenchmarkShare fixture.signature expected_requests`
and `HTTP test socket timeout invalid JSON retry external boundary isolation`,
then direct searches for `verify_agent_reachable` and `socket timeout`. The
September 30 socket-option fixture case is a relative; the October 1 evidence
transcript case introduced the separate timeout controls but has a different
first bad production boundary. This is a new fixture cause, not recurrence of
the transcript or recording validation defects.

## Solution

Keep real sockets for header stalls, partial-body stalls, recovery and persistent
timeout. Deliver HTTP 403 and malformed JSON deterministically through urllib's
external transport boundary. Each observed invalid response must cause exactly
one request and no browser call. A separate explicit first-timeout-then-invalid
sequence must cause exactly two requests and no browser call. Assertions inspect
the actual HTTPError/JSONDecodeError cause so an unrelated failure cannot pass.

The production publisher and browser validator are unchanged. All caller
timeouts remain 100ms in this fixture; the production retry count and deadlines
are unchanged. The canonical command
`bash scripts/tests/publish_evidence_links_browser_validation.test.sh` passes.
The suite is already registered in the normal `/deploy` structural gate.

Two source-scoped in-memory production mutants separately broadened the timeout
catch to HTTPError and JSONDecodeError. Both failed the new exact-one-request
assertion; no production file was edited. These mutants check that the fixture
does not silently accept broader retries. The deployment owner independently
reviewed the source and causal proof, found the bounded contract clean, adopted
the proposal into the combined source and reran the canonical fixture with exit
zero. This closes the fixture defect; full qualification and deployment remain
the root deployment owner's responsibility.

This simplifies the fixture by removing nondeterministic socket scheduling from
response-classification assertions and reuses its existing SyntheticTransport
pattern. Golden references use the same separation: Codex
`sdk/python/tests/test_artifact_workflow_and_binaries.py:624` injects HTTPError;
`scripts/codex_package/test_v8.py:246` supplies BytesIO at urlopen; Hermes
`tests/website/test_fetch_plugin_stars.py:77` injects HTTP 403; OpenClaw
`packages/memory-host-sdk/src/host/batch-http.test.ts` supplies responses at the
remote boundary while checking exact retry counts. A search of the vendored
Claude Code test sources found no matching HTTP fixture analog.

At 10k agents there is no runtime change, per-agent work, shared-state change or
new polling. The registered fixture uses the same three bounded local socket
cases and four small deterministic response sequences, only during deployment
checks. All owned HTTP threads are released and joined by the existing finally
cleanup; no provider, native worker, database or paid action was used.

## Human feedback

None recorded. The deployment owner required preserving invalid-response
rejection, timeout/recovery controls, exact request counts and no-browser
semantics; this is task context, not invented user feedback.

## Reusable lesson

Separate response-delivery timing from response-classification assertions while
retaining real socket controls for the transport deadline itself.
