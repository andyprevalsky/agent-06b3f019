---
id: 2026-11-09-post-cleanup-fixture-mixed-current-bytes-with-historical-pins
date: 2026-11-09
title: Synthetic post-cleanup history returned current producer bytes under old pins
surface: harness
component: scripts/tests/deploy-test-cycle.test.py
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: post55_fixture mocked historical source_bytes with current checkout bytes while leaving historical producer pins active
symptoms:
  - 'backend post-execution cleanup: original producer changed'
  - post-cleanup negative controls failed before reaching their intended predicate
  - 'ValueError: native payload differs from original'
  - 'InterruptedFreshRecovery setUp fails before all 15 intended assertions'
tags:
  - deploy
  - cleanup
  - source-pins
sources:
  - PR #1682 recurrence, 2026-11-11
  - commit 7cef661160b2a73a60a81288e4630ad16d38d31f
  - commit dbfcdb3aac66044346027199d1d1ecc9f089f65b
  - commit 8914dd02e1f424c0345ce70752d791f8426070a6
repro: python3 scripts/tests/deploy-test-cycle.test.py LocalCleanup
status: open
---

## Problem

The full coordinator suite failed post-cleanup fixture cases at `original
producer changed`. The positive setup used a synthetic historical head, while
its source reader returned today's checkout bytes. Main had changed two of the
seven pinned producer files. All seven actual historical source blobs still
matched the production pins, so the validator correctly rejected the fixture's
incoherent source construction.

## Diagnosis

The first bad boundary was the fixture reader, before the intended domain,
recipe, observer and skip-negative predicates. Production pins and historical
source authentication were correct. The same five owning methods failed against
the original fixture and passed unchanged with coherent construction. Read-only
historical comparison distinguished the two changed current files from the seven
valid old producer blobs; no production source map was widened.

## Solution

The fixture now snapshots its producer bytes and computes a matching,
test-scoped pin map. Its mocked reader asserts the exact synthetic root and
head, then returns those snapshots. Context-managed patches restore the actual
production pins after the test. This keeps the test hermetic in a fresh or
shallow checkout; it does not require an old branch object. The existing
changed-producer negative still rejects drift. Assertions, timeouts, validator,
auditor and production pins remain unchanged.

Independent review cleared the exact fixture-only hunk. The original full-suite
failure and owning RED/GREEN supervisor receipts remain in private deploy
evidence. This correction grants no native cleanup or full-gate credit; the
complete coordinator and final-source gates are separately required.

## Human feedback

No new human feedback. Independent agent review covered the fixture only.

## Reusable lesson

A synthetic history must pair its declared identity with coherent immutable
bytes and hashes. Do not authenticate today's checkout as an older producer.


## PR1682 recurrence on 2026-11-11: historical fresh-prestart payload

Native merged-source deploy-test-plan on7cef661160b2a73a60a81288e4630ad16d38d31f
reported15ERRORS in InterruptedFreshRecovery.setUp before those tests reached
their positive/negative predicates. The original occurrence is
cc1d06ee5acb46c9b98745e1cbd947ef, source digest
b7970a05fe0acdfaff96f6d48739e7d4d59473174137b91b6e5e8888ec719342.
FreshPrestartRecoveryTest declared source2d4c45c0da9c56e7145b2f3df8114cc5b95b7bb3
but constructed both native config boot-file bytes and gzip driver payload from
the current checkout. Its plan caller then relocated the established fixture
without rebuilding those original payloads. The validator read the declared
historical Git source and correctly rejected native payload differs from original.
A path relocation cannot change already encoded bytes.

Gate: INTRODUCED integration incompatibility relative current main dbfcdb3a.
Historical2d4c45 and incoming main dbfc have identical boot and driver bytes;
7cef retains deliberately changed branch implementations. This does not make
the production equality guard incorrect or authorize replacing historical pins.
Read-only source comparison records boot SHA66ce198f at2d4/dbfc versuscd6eea1b
at7cef, and driver SHA1958de17 at2d4/dbfc versusdb2cf568 at7cef. The first boot
mismatch also hides the independent driver mismatch. This is the same archive
lesson as the original case: declared historical identity and payload bytes must
be coherent. The remedy differs because this fixture intentionally tests a real
recognized historical startup protocol rather than synthetic pin maps.

Proposed fixture-only correction reads BOTH boot and driver from its exact
self.sha using git --no-replace-objects --no-optional-locks show before building
any compressed payload or native before/after config. It keeps self.sha,
FRESH_SOURCE_PROTOCOL, paired source/history verification, production validator,
all15plan assertions and existing payload/driver tamper negatives unchanged.
No dummy commit, current-source substitution or widened accepted protocol.
The initial one-file historical-payload patch SHA34f98424a95fded6d81cbbfc600351d287e472253cf9ac7f9ce68c1656f3a221
and fixture SHAadbd56e7940c026d548a196c59c385b39ac4c7f0394dcbebddf88365e104c4d6
remain preserved as v1. Root ran the same actual semantic-negative case on
unchanged source: FAIL in0.133s with original payload error, then PASS in18.311s
with only candidate fixture bytes intercepted at its runpy load. Both native
supervisors terminated quiescently, preserving actual failure and success. The
harness retains original __file__/SCRIPT/ROOT and intercepts only the one fixture
load. This is local causal proof, not source application or native gate credit.

The initial full prestart run then reported27tests/2FAIL: both extracted shell
caller fixtures omitted fleet_recovery_prepare_replaced_preconfig and exited72.
A separate v2 candidate extends the same one-file fixture to extract the actual
fleet_has_replaced_preconfig, fleet_recovery_prepare_replaced_preconfig and
fleet_recovery_verify_replaced_preconfig helper bodies. The fixture has no
replacement markers; the real has check refuses applicability, so actual native
guards return their ordinary no-replacement result. Unsupported replacement
planning still refuses. No fake successful guard, production helper change,
timeout relaxation or assertion deletion was introduced. The full27 owning
suite now PASS in12.031s under native exit0/quiescence/noorphans/remainingempty.
V2 fixture SHA7fab09f23b28b396439287d091f8a651e50e80ebd1353208e55e1d03075044b3;
combined one-file patch SHA5d98849c9bdd805dc478f2aec6478714c55be193000748a59efa354380f2f365.
V1 source stayed frozen throughout its active runs; v2 used a separate path.

The initial full-plan diagnostic run completed99tests/2ERRORS. Its actual traces
are KeyError:<run_path> at sys.modules[__name__], confirming the outer runpy
harness failed to register the loaded plan module. Those are diagnostic-harness
errors, not evidence for a source fix. A corrected registered witness-pair run
separately failed1failure/1error on strict process-census refusal for unverifiable
PID2669036. The exact source of that transient process/refusal is unknown;
concurrent process-observation fixtures are a lead, not a proven cause. Preserve
both failed receipts; do not filter the census, widen provenance, or change any
runtime guard to clear them. The correctly registered serialized full-plan v2
run completed99tests PASS in288.059s under strict native exit0/quiescent true,
noorphans and remainingempty. Its exact candidate fixture remains7fab09f2 and
the registered runner remains source-bound to that hash. This closes the local
full-plan validation gap without altering process scanners or production
provenance guards. The prior witness refusal and invalid v1 harness results stay
retained; no overlap cause is inferred from later success. Applied-source native
coordinator/deploy validation remains PENDING; local99PASS is not that credit.

This recurrence is OPEN while source integration and applied native validation remain
pending; the original2026-11-09 fix remains historically recorded above. Root
retains original native occurrence and all unrelated failures/resources/debts.
No benchmark/provider/DB/credential/cache action follows from this fixture fix.
There is no model-visible change or model-quality claim.

Human feedback for this recurrence: None recorded. The deployment coordinator
limited this reviewer to read-only analysis and context-only drafts while
healthy source consumers run; that is coordination scope, not invented user
approval. No reviewer tests/imports/source changes were performed.
