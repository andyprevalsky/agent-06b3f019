---
id: 2026-10-15-recording-concurrency-counted-retired-server-handlers
date: 2026-10-15
title: Recording archive fixture counted server handlers after their client requests had completed
surface: harness
component: recording-archive-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the fake server retained its active counter after writing a complete response body while the released client worker could start another request
symptoms:
  - closed_recording_archive_backlog failed after accepted bytes and restored slots passed
  - "AssertionError: unchanged4workers must retain all70 files and original publisher"
  - "len(calls) == 71 and peak_active <= 4"
  - controlled server peak 5 with client request peak 4 and 71 distinct paths
tags:
  - recording
  - archive
  - blackbox
  - concurrency
  - measurement
  - fixture-lifetime
sources:
  - commit b5475e5be1f98e48e709298c0afcd2ea2e550ce7
  - commit 7ed2b2376218bdd53405e6dad3efa0b07644f197
  - agent ph76b0rxy1a8ed810xb8nn38v58g8p9m parent coordinator
repro: agents/tests/blackbox/recording_archive.blackbox.py
status: mitigated
---

## Problem

A full agents verification at frozen b547 reported the recording-archive domain
12 PASS and one FAIL. The backlog child reached its final conjunction at
`_recording_archive_closed_fixture.py:313`, after all70 body captures, exact
accepted-file bytes, empty outbox/pending futures, zero reserved bytes and all64
restored slots had passed. The original stderr did not record either conjunct's
value. Its actual failing conjunct remains unknown; this record does not assign
an unmeasured value retrospectively.

The original credential-free log was supplied at
`/home/boxes/.devbox/desktop-attachments/rose-b9250d0f0727/ph76b0rxy1a8ed810xb8nn38v58g8p9m/backlog.private--fc869179a05fedf05fa3.log`.
Private reproduction artifacts are under
`.context/auth-deploy/archive-backlog-rca/`. The live all30 source, active tasks,
credentials, clocks and existing verdicts were untouched.

## Diagnosis

The exact unchanged child passed one isolated baseline and six diagnostic runs:
71 distinct paths,71 artifact attempts and peak4 in each. Natural reproduction of
the original failure was therefore absent in that sample.

A controlled legal scheduling interleaving then failed the unchanged original
assertion with server-handler peak5, while an independent observer measured
client-request peak4 and exactly71 distinct paths/attempts. Every preceding
integrity/lifecycle assertion still passed. The private scheduler forwarded the
first real response body unchanged, then held that handler after the complete
length-delimited body write until the next handler began reading its request.
It changed scheduling, not the input files, limits, ACKs or assertion.

The fake server incremented its active counter before parsing the request and
decremented it in handler finally, after `wfile.write(payload)`. HTTPX could
consume the complete response and return, freeing one of the existing four
archive executor workers to start the next request before the previous server
thread retired its counter. Consequently that counter measured asynchronous
server-handler lifetime, not the client-worker concurrency named by the test's
four-worker invariant. Production `trace_archive.py` still constructed
`ThreadPoolExecutor(max_workers=4)`. No runtime worker expansion or slot leak was
established. Recorder abort is not called by this backlog path.

The owned defect demonstrated by the controlled reproduction is a measurement
contract mismatch. It is a plausible mechanism for the original symptom, not
proof that the original unmeasured conjunction failed for this reason. Status
remains mitigated to retain that attribution gap despite the proven local
measurement correction.

Archive searches for `closed recording / archive backlog / semaphore` and
`recording archive / admission / producer abort`, followed by literal
`closed_recording_archive_backlog unchanged4workers`, found no matching prior
boundary. The missing fixture environment case of September11 and the
October1 fixture-lifetime recurrence in the July14 teardown case are relatives:
one fails before publication, the other lets accepted jobs escape their fixture.
Neither establishes this response-completion/counter-retirement cause.

An earlier threaded frame-tracing scheduling diagnostic distorted shared
nonlocal counters and was invalidated. Its `controlled-handoff.log` remains
preserved, excluded from causal proof. The safe transport hook uses thread-local
state and does not manipulate frame locals or assertions. Its aggregate field
`next_entered_before_handler_retired` counts later reads after an event, not
67 simultaneous handlers; only the first synchronization proves the handoff.

## Solution

Commit7ed changes only the existing child fixture and its owning test wrapper.
It brackets actual nonstreaming `httpx.Client.send` through complete response
consumption, with a locked decrement in finally. Server activity remains a
separate scheduling barrier. The original `len(calls)==71 and peak_active<=4`
assertion is unchanged; its before/after AST SHA256 is
`ec32546ae2fa659c89c8fd5f4c84014750e954831ea6ecc2e3bd13b440bbbbf4`.
An additional exact71-attempt assertion strengthens duplicate detection.
Default four workers, producer priority, bytes, encryption/ACK behavior, outbox,
byte reservations and64-slot checks remain intact.

The same controlled schedule produced old FAIL/server5/client4 and corrected
PASS/client4, with71 distinct paths and71 attempts in both. A deliberately
configured five-worker child produced five genuinely overlapping client
requests and failed the same four-request limit with71/71. The existing domain
registers a negative control that requires that exact assertion failure and
measured five-client peak. It cannot pass merely because the child crashed.
Negative and positive diagnostics use distinct artifact filenames.

The final canonical runner in the isolated exact-base overlay passed all14
controls,0FAIL in14.3seconds:

```bash
cd /home/boxes/rose/.context/auth-deploy/archive-backlog-rca/worktree/agents
PYTHON_DOTENV_DISABLED=1 PYTHONPATH=/home/boxes/rose/.context/auth-deploy/archive-backlog-rca/offline-guard:/home/boxes/rose/.context/auth-deploy/archive-backlog-rca/worktree/agents RCA_OFFLINE_GUARD_RECEIPT_DIR=/home/boxes/rose/.context/auth-deploy/archive-backlog-rca/domain-guard-receipts /home/boxes/rose/agents/venv/bin/python scripts/run_blackbox_tests.py recording-archive
```

The guarded controlled commands from the original repository directory are:

```bash
agents/venv/bin/python .context/auth-deploy/archive-backlog-rca/run_guarded_fixture.py --diagnostic --baseline --controlled-handoff
agents/venv/bin/python .context/auth-deploy/archive-backlog-rca/run_guarded_fixture.py --diagnostic --controlled-handoff
agents/venv/bin/python .context/auth-deploy/archive-backlog-rca/run_guarded_fixture.py --diagnostic --five-workers
```

Run those only in the credential-free fixture environment described in the
retained findings; the commands denote mocked local archive work, not live
models or providers. Expected exits are1,0,1. The existing registered suite
checks the negative child as an expected rejection.

Across two full domain runs,24 process receipts recorded zero forbidden HTTP or
socket attempts, and346 requests/connections to exact self-owned loopback fake
archive servers. Those local sockets are not mislabeled zero socket activity.
No provider, model, inbox, database or shared-service calls were made. Production
runtime diff is empty; source worktree was clean after the test-only commit.
Independent read-only peer review passed the final two-file diff; final runtime
verification completed separately afterward. Patch SHA256:
`7a2f39bf7542f27f8c768ede1f46db573ee12798e6949b6c3f76e20d156a39ce`.

The test-only correction was accepted by the parent coordinator for a later
reviewed integration batch. This worker did not push, adopt, deploy or alter the
active all30 tree. No current auth-choice failure is repaired or reclassified by
this fixture change. No production concurrency policy or human approval scope
was expanded.

## Human feedback

No separate direct end-user correction was recorded during this fixture RCA.
The parent coordinator required exact conjunct diagnostics rather than a guess,
kept the original conjunct unknown, and authorized a private test-only correction
after the controlled evidence. The parent required the same controlled old/new
comparison, a genuine five-client negative, all original integrity assertions,
canonical domain verification and explicit distinction between zero forbidden
transport and self-owned loopback requests. The parent's acceptance was for this
test-only patch; earlier user approval942 was not treated as approval of new
runtime bytes.

## Reusable lesson

Measure a concurrency invariant at the owned client-operation boundary and prove its observer rejects real over-concurrency instead of counting asynchronously retired server handlers.
