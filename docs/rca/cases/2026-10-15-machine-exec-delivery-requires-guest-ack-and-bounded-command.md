---
id: 2026-10-15-machine-exec-delivery-requires-guest-ack-and-bounded-command
date: 2026-10-15
title: Machine exec accepted CLI status zero while the delivery body rejected an oversized diagnostic
surface: infra
component: cloudbench-machine-exec-delivery
classification: input-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: operator inline diagnostic command crossed machine-exec delivery without a bounded UTF-8 preflight
symptoms:
  - PayloadTooLarge
  - MethodNotAllowed
  - timeout must not exceed 600 seconds
  - transport_exit 0 with stderr-only body and unconfirmed guest execution
tags:
  - machine-exec
  - delivery
  - guest-ack
  - payload-budget
sources:
  - plan: original diagnostic d705637 and corrected e127008 retained under author v39-publisher-phase-diagnostic
  - plan: same bb02fd5cd6ae18425f6fb67aa093ca3cd4d1d80eb1fa97cf4a89f6213fe4bf72 program accepted by staged delivery 58e11c97
  - commit c77288b3133e86a01759a2c6cd081c61a152818c original source
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py MachineExecDeliveryTests
status: open
---

## Problem

Two actual diagnostic command requests, 16098 and 15045 bytes, returned CLI
transport exit zero and the same 196-byte stderr-only JSON envelope containing
PayloadTooLarge and repeated MethodNotAllowed. The actual callers correctly
kept guest execution, native GET execution and joins UNKNOWN. This incident did
not create a false benchmark PASS and is separate from publisher freshness.

The identical program SHA bb02fd5cd6ae18425f6fb67aa093ca3cd4d1d80eb1fa97cf4a89f6213fe4bf72
later ran after three inert chunk deliveries with command sizes 6943, 6923 and
6871 bytes and a 3425-byte execution command. Every chunk length/hash and the
assembled compressed/program hashes were checked before execution. Actual
successful receipt 58e11c97 retained 600 joined readers. No additional provider
operation was used for this RCA.

## Diagnosis

The path is operator program -> inline encoded command -> raw Fly.flyctl ->
CLI transport status plus JSON envelope -> guest stdout -> caller-specific ACK.
The first rejected boundary was command delivery, before verified guest work.
The exact provider request-size threshold and which MethodNotAllowed entries
represent routing fallthrough remain unknown; the successful commands only
establish a tested operating envelope, not a provider capacity guarantee.

The existing Fly.flyctl deliberately returns raw status/stdout/stderr. It must
not globally reinterpret every command. What was missing was a reusable opt-in
preflight and typed ACK contract for diagnostic machine-exec callers. The old
callers already checked their bodies manually; this is prevention/unification,
not a claim that they falsely accepted the rejected body.

Local reproduction uses a clearly labeled raw-caller replay baseline delegating
to the unchanged Fly.flyctl contract with recorded responses. The unchanged
permanent assertions fail on missing command-byte preflight and acceptance of
the stderr-only envelope. They pass after the optional typed method is supplied.
This baseline adapter is not a previously shipped machine_exec_json method.
The first pytest invocation failed collection because the owning .test.py file
is a unittest executable; canonical python file/class invocation supplied the
real RED and GREEN. Logs and exact source copies are retained privately.

Archive searches were PayloadTooLarge MethodNotAllowed machine exec and
transport exit zero body validated oversized command. The exact error-only
search had no prior hit. The October 7 startup archive assumed-shell case is a
related transport-contract incident, not this cause.

## Solution

Candidate optional Fly.machine_exec_json preserves raw Fly.flyctl unchanged.
It requires an explicit positive caller command-byte budget, a positive existing
execution timeout and callable ACK validator. Oversized UTF-8 commands refuse
before transport. After one call it requires transport success, a bounded typed
stdout envelope without an error, optional integer-zero guest exit, an inner
JSON object and the caller validator returning exactly True. Private output is
never printed in exceptions. There is no automatic staging, retry or fallback.
The caller remains responsible for source, nonce, expected hash and stage ACK.

The 7000-byte test budget is conservative caller policy informed by already
accepted commands, not an invented provider maximum. The existing explicit
staging remains inert O_EXCL/private chunks plus complete program hash before
execution; the optional method does not invent a staging framework. At large
width the guard adds no provider fanout; each authorized call remains one call.

The permanent tests are added to the existing bootstrap recovery unittest
family, already invoked by run-deploy-structural-gates.py. They cover recorded
rejection, UTF-8 size, valid exact ACK, malformed/error/wrong ACK, response bound
and missing validator. Only local mocks run; no selected benchmark grade or
provider limit is proved. The focused seven tests pass. The complete owning runner ran 37 tests and
retained two failures plus three source-policy review errors; it is not called
green. A 1.14-second baseline-fixture check proved that the three errors and
one phase-list failure precede this addition: the unchanged committed policy
has no entry for its 9fe43cc6 fingerprint. The other failure occurs before
snapshot entry; 33 required copy inputs are absent from the sparse workspace
and exist in its committed baseline. The original test class AST is unchanged.
No review guard was waived and the full family was not repeated. Evidence is
in the component directory baseline-classification.safe.json. Parent independent
review, integration/source freeze and normal trusted phase qualification remain
pending, so status stays open.

Golden reference review: claude-code-src/src/utils/execFileNoThrow.ts:121 keeps
explicit code/error; hermes-agent/tools/code_execution_rpc.py:45 has checked
execution and keeps payload separate from remote write commands; codex/codex-rs/
app-server/tests/suite/v2/process_exec.rs:99 checks terminal exit/output distinct
from spawn response; openclaw/extensions/openshell/src/backend.exec-workdir.test.ts:93
passes explicit completed/exit/timedOut execution metadata. These are related
patterns, not Fly payload-size contracts. No reference clone/download ran.

## Human feedback

The user requires unchanged all600 simultaneous execution with infra strictly
below 5 percent and no full deploy prerequisite for each experiment. Root
explicitly scoped this RCA to reusable diagnostic delivery prevention, without
changing publisher files, provider limits, benchmark profiles, clocks or grades.

## Reusable lesson

Bound the actual command bytes before dispatch and validate the guest's source-bound ACK independently of the transport process exit.


## October 15 follow-up: native exec timeout ceiling

A later canonical `Fly.machine_exec_json(660, ...)` dispatch failed before any
confirmed guest JSON. The private original stderr is 175 bytes with SHA256
`d66d237bde272236170fdeca754d23da6d8d67f87d3e8edbc51ffc4a6df5816e`
and contains `timeout must not exceed 600 seconds`. Transport status was 1 and
stdout empty; these facts do not prove guest cleanup or benchmark failure was
fixed. No new provider or guest call was made during this follow-up.

This is a recurrence of the optional adapter's incomplete pretransport contract:
it checked positive integer timeouts but did not enforce the observed native
600-second maximum. The owning permanent `MachineExecDeliveryTests` now exercise
601 and the actual rejected 660 before any mocked provider dispatch, the valid
600 boundary with exact forwarded arguments, and unchanged raw `Fly.flyctl`
behavior with an outer 660-second process bound. Before the fix, the same ten-test
command failed twice (`Refusal not raised`); after the two-line optional-helper
guard, all ten tests passed. Logs, source hashes and the exact diff are retained
under the author checkout's `.context/rca-exec-timeout-limit/`. Existing native
ACK, command UTF-8 budget, one-call/no-retry and response validation controls also
passed. The existing structural deploy runner discovers this unittest family.

The change rejects unsupported input; it never clamps or increases a timeout,
retries a request, adds a fallback, or changes raw CLI behavior. The operator's
separately authorized foreground recovery is independent and its outcome remains
unproven by this local regression. The earlier payload/route investigation stays
open at its recorded evidence boundary. Archive searches used the literal timeout
refusal and `machine_exec_json validation provider dispatch`; direct literal code
search identified this existing adapter case. The existing golden-reference
execution/receipt separation remains applicable; no reference claims a Fly limit.
