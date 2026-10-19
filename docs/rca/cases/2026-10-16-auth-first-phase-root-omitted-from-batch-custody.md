---
id: 2026-10-16-auth-first-phase-root-omitted-from-batch-custody
date: 2026-10-16
title: Auth setup roots were omitted from deferred benchmark custody
surface: agents
component: benchmark-cloud-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: auth first-run fixture accepted create_agent identity but never registered that root with task and deferred batch cleanup custody
symptoms:
  - "first run did not complete (status=ACTIVE)"
  - "first-phase root absent from graded result and batch cleanup"
tags:
  - benchmark
  - fixture-cleanup
  - ownership
  - ungraded-stage
sources:
  - commit f0fe35fbb9ccbbb426fdbc49d46b36d0454c26f2
  - commit bb7c462a92445b6595c9e5b5544b665c42c90f0f
  - benchmark run 0d05e7c4-df68-4ef3-bb48-f4c8d9b07be7
  - plan: private candidate SHA256 a5a20cb0be138bccd0bc44eff295f52f1f64127854eaea4f4373d10d3b5a15c5
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_actual_task_runner_exports_fixture_custody_without_graded_root
status: open
---

## Problem

The unchanged `browser-auth-created-account-reused` task failed in 894.9s on
f0. Its first fixture root, `87342be3-cc7e-412c-a114-9e370e9a09f3`, exceeded the
original one-browser-call contract after a model-authored extra confirmation-ID
requirement led to a second browser spawn. The fixture then reported its first
run still ACTIVE. The graded reuse phase was never admitted. That original
semantic/tool-contract failure remains OPEN; this custody candidate neither
changes the task nor proves that failure repaired.

Separately, the fixture's successful create returned a real root ID before
polling. `_run_auth_test_site_first_run` did not register it with the batch's
creation callback. On first-stage exception, the graded result correctly had
an empty agent_id, but there was no independent first-root custody record.
The same omission affected completed ungraded first root
`d0600f38-2442-4582-a159-4519005ba285` for the saved-login reuse fixture.
Source inspection found the same boundary in f0 and bb7.

## Diagnosis

What: an allocated setup root was missing from the deferred finalizer's owned
root set, not merely missing a display URL. Where: the first fixture's
create→poll boundary and TaskResult→batch-finalizer representation. Why: only
the later graded create called the existing callback; a single primary graded
ID could not represent independently allocated setup roots. Proof: the real
first-fixture producer and real `run_single_task` fail the unchanged callback
ownership assertion before first polling on exact bb7. Problem: allocation
custody depended on later-stage completion and a single graded identity.

Archive searches covered “fixture custody / failed init” and “first root /
deferred cleanup.” Related cases are
`2026-10-13-browser-auth-persist-fixture-dropped-failed-init-custody` and
`2026-09-11-deferred-cloud-cleanup-lost-root-owner`. The former concerns backend
init allocations and destruction of recovery identity; the latter preserves
an already-known root's user identity across deferred cleanup. This case adds
the distinct benchmark producer omission of an entire ungraded root. It does
not supersede those cases or repeat their outcome claims.

C is multi-phase benchmark root custody. The coherent broader C+1 is retaining
allocation receipts independently of success or primary-result identity,
through cleanup and export. The candidate applies that class at the actual
owned benchmark producer/result/finalizer boundary. No prompt correction or
failed-coherence claim is selected; this is not proof that every allocation
producer in the repository has been audited.

## Solution

The selected three-file candidate synchronously registers each returned
root before polling; retains task, role, creation receipt, actual stage outcome
and logs; and binds them to the actual TaskResult. Fixture-first roots do not
replace nullable graded agent_id or its report-card URL. The existing finalizer
consumes explicit roots, checks task/role/UUID/stage identity and duplicate
bindings, then uses existing exact owner, seal, provider and payment checks.
Unknown graded allocation still fails closed while known fixture roots can be
finalized. Existing FAILED/ERROR/CANCELLED results remain authentic.

Independent review BLOCKED predecessor `646dbc2e…`: its ungraded fixture root
would inherit the parent graded benchmark outcome through the scoring archive
helper. The corrected candidate archives fixtures with
`archive_agent_finalize(..., force=True)` without benchmark-grade arguments or
world-model scoring. Graded archive behavior remains unchanged. Actual stage
outcome stays in fixture custody, not a fabricated benchmark grade.

The real producer→runner→finalizer→asdict export control covers early failure,
raised exception, cancellation, foreign snapshot, completed first stage then
unknown graded create, and both stages complete. Additional controls reject
foreign/duplicate/unknown creation and missing seal/provider proof. All 147
original assertion ASTs remain; final file has 163 assertions. The existing
Cloud Benchmark Lifecycle suite registration is retained.

Private evidence root:
`.context/auth-deploy/fixture-root-custody-review/`.

- `baseline-final-real-runner.log`: SAME actual producer assertion FAIL on bb7,
  zero network attempts.
- `archive-grade-before.log`: SAME archive-owner assertion FAIL on predecessor.
- `archive-grade-after-v2.log`: final selected two cases PASS, 0.64s, zero network
  attempts, including exact fixture archive args and graded-root grade kwargs.
- `full-cleanup-final-v4.log`: 42 pytest cases PASS in 4.29s, but launcher EXIT99:
  TWO pre-existing localhost39999 attempts were DENIED and TEN connections to
  listeners bound by the test process were allowed. No unowned traffic was
  transmitted. This is not an unqualified all-green guarded invocation.
- `candidate-archive-safe-v2.patch` and `archive-safe-v2-proof.json`: exact base
  bb7, final patch SHA256
  `a5a20cb0be138bccd0bc44eff295f52f1f64127854eaea4f4373d10d3b5a15c5`.

Commands use the read-only existing private venv Python and the retained
`run-tests-strict.py` selected-control launcher / `run-tests.py` full owning-file
launcher. No provider/model/site/DB/inbox calls were performed. Earlier failed
preparations, extracted-wrapper namespace failure, missing archive fake-edge
attempts and unsafe archive-grade predecessors remain retained. Independent
reviewer ph792 accepted the final scoped source correction after the blocker
was addressed. No integration/canonical-native repair claim follows.

## Recovery evidence and limits

Separately authorized root-owned canonical recovery sidecars completed for BOTH
actual roots. Exact retained receipts, not inferred success, establish pause,
archive, provider release and terminal payments:

- failed first root873: `failed-first-root-recovery-result.json`, exit0,
  three provider receipts, evidence SHA256
  `d06c6d8d0fe33fb8454bb44666fe578ec63d39327611128fc250c0dc4f8643e2`;
- completed ungraded first rootd060:
  `completed-first-root-recovery-result.json`, exit0, one provider receipt,
  evidence SHA256
  `6366d718254a717922cb8a9f2941eecb96cf656a3541c914f7805eaabccd77d4`.

Both are under
`.context/auth-deploy/repair-native-full30-20261016-1927/created-account-reused-rca/`.
Their own recovery processes joined. Neither original native ACK/export nor
verdict was changed. Earlier receipts' still-pending sibling/release statements
are historical snapshots; the later second receipt settles that exact sibling
only. Entire campaign release/publication is a separate controller obligation.

Recovery does not turn the original task into PASS or prove the private source
candidate in native execution. In-memory custody cannot guarantee export after
catastrophic process death; unknown create cannot be cleaned without exact
identity. First-stage snapshots increase result payload size. No universal
class-elimination, durable journal, or all-history reconstruction is claimed.

## Human feedback

The user said: “dont ask me to aprove prompt changes unless they prove it
passes, u only need approval at the deploy step”. No deployment is authorized
by this draft. Parent accepted the source candidate for a NEXT batch only;
current bb7 remains immutable. Preserve Freedom and protected instructions,
all original tasks/evaluators/deadlines, source evidence and native failures.

## Reusable lesson

Track every proven allocation as its own owned stage before awaiting later
work. Keep ungraded setup custody and archive evidence separate from graded
outcomes; successful cleanup cannot manufacture benchmark success.

## Combined-source checkpoint

The reviewed archive-safe candidate is selected for the next combined source
with upstream d6e8edc6. Canonical combined-source and unchanged native task
verification remain pending. Private owning proofs and the separately executed
legacy recoveries do not close the original semantic failure or this OPEN case.

## Combined-source validation follow-up

The ec371 combined source retained two actual validation failures. The complete
agents run ended with 110 passing domains and one failing benchmark domain; its
existing `test_live_report_keeps_all_created_roots_for_batch_finalization`
assertion showed that adding a second graded root replaced the report's first
graded primary. Custody still retained both allocations. The correction uses
`setdefault` only for the existing non-fixture primary map; unconditional root
registration and fixture exclusion remain. The SAME registered assertion fails
before and passes afterward. Additional real harness controls cover a fixture
without a graded root, and a fixture followed by two graded roots: the primary
stays nullable or first-graded respectively, and every allocation stays owned.
All 2,523 previous assertion ASTs remain, with two additional assertions.
Private source proof is in
`.context/auth-deploy/first-graded-primary-review/`; patch SHA256 is
`3f3a618352637a652d960eb11213e615dc69ca7aed495a2af95f3f17c524e6c2`.

The complete deploy structural registry separately ended 46 passing suites and
one failing benchmark-live-results suite. Its real boot/interrupt fixture
returned literal `root-agent` from fake creation. The canonical allocation UUID
guard correctly rejected that malformed identity before polling. The fixture
now supplies one fixed valid UUID consistently to creation, tree, exact-owner
checks and the existing twelve-character creation-log checks. No production
UUID, duplicate-allocation, shutdown, cancellation, timeout or cleanup-ACK guard
is weakened. The SAME selected test fails before in 18.80 seconds and passes
after in 1.64 seconds. All 3,042 assertion ASTs and other source bytes match
after normalizing the five changed identity literals. The private launcher
allowed only loopback listeners bound by its own fixture; the passing run made
30 such connections and no denied or external connections. Earlier preparation
and guard-setup failures remain retained in
`.context/auth-deploy/boot-fixture-uuid-review/`. Patch SHA256 is
`f4ad299cb4f3f21e21bd5178e0478dccf5c2e0da8a5953a84f021e2e982980f3`.

These follow-ups require a fresh combined-source validation run. They do not
change the original six native task failures, establish a native semantic
repair, or turn the old ec371 validation attempt into PASS. Its healthy backend
coverage continues on its immutable checkout while the separate next checkout
is prepared; no prior gate result is relabeled as a result for the new source.
