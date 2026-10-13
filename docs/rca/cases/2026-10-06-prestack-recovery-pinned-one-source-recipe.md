---
id: 2026-10-06-prestack-recovery-pinned-one-source-recipe
date: 2026-10-06
title: Pre-service recovery could not validate a newer immutable source recipe
surface: infra
component: cloudbench-prestack-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_bootstrap required one historical source ref and a stack log even for genuine pre-stack cancellation
symptoms:
  - exact stopped task-free canaries remained quarantined after controller exit
  - newer clean source did not match the historical bootstrap attestation
  - one genuinely acknowledged cancellation had no stack log
tags:
  - cloudbench
  - prestack-recovery
  - source-binding
  - cancellation
sources:
  - PR #1422 follow-up
  - commit 8ed0c776d351e5bbd86494646871d5c676e5a2cc
  - fleet run 20261006-180741-40762
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py
status: mitigated
---

## Problem

The failed fifty-copy preflight allocated two task-free infrastructure canaries.
The original supported recovery refused their incomplete normal runtime seals.
Both guests were stopped and their original volumes captured through inert
boots, with exact original configurations restored afterward. One guest had an
original cleanup ACK but never launched its stack; the other stopped during
isolated database index bootstrap without launching application services.

Neither guest executed a benchmark. Their native allocation-to-destruction
lifetimes were 1,657 and 1,685 seconds, exceeding this diagnostic's 1,200-second
cutoff. Both therefore retain zero acceptance credit. Original bytes and
source/native receipts remain private under
`.context/fresh-basic-claude-final50-20261006/`.

## Diagnosis

Archive searches covered prestack recipe/source rejection and absent stack
logs. The
[child-token case](2026-10-04-pool-recovery-rejected-child-shutdown-token.md)
concerns receipt identity, and the
[runner-before-stack-cleanup case](2026-09-29-runner-receipt-accepted-before-stack-cleanup.md)
concerns promoting a narrower runner receipt. These related cases do not
establish pre-service absence for a new source recipe.

The bootstrap validator encoded a single historical Git ref and source hash.
It also required a stack log for the only supported bootstrap shape. The
current clean native ref and a genuine earlier cancellation could not satisfy
those predicates. Accepting their owner token alone would have repeated the
older unsafe receipt-promotion defect.

The actual unchanged original-volume captures failed on the original validator
and passed after a source-bound extension. Independent review bound all fifteen
packed executables, three boot controls, checkout helpers, original execution
provenance, archive contents and native configuration. A first draft checked
only the driver/fetch pair; review required binding every actual executable.
The pre-stack and index-bootstrap phases were reviewed separately against their
captured source. No review of an unobserved later phase was borrowed.

## Solution

The permanent validator derives the immutable source recipe from the exact
native full Git ref and captured clean checkout, instead of a named historical
commit. Every injected executable and canonical script input must match that
recipe. Publishing or reusing the separate bootstrap receipt requires an
independent review binding the same ref, recipe hash and pre-service phase.
No actor name or historical ref bypasses this review.

A pre-stack cancellation requires its genuine original ACK and proven stack-log
absence. Index-bootstrap cancellation retains its original exited state,
descendant/service absence and source-phase checks. The receipt never becomes
a synthetic guest ACK, provider manifest or benchmark result. Normal exact
recovery still verifies native Machine and volume release.

The reviewed zero-credit native recovery finished in 63.780 seconds. Exact
provider GETs returned both Machines destroyed and both unattached volumes
pending_destroy. The owning registry and claims were absent; all thirty-five
baseline Machines and fifty baseline volumes, the stopped donor configuration,
and an unrelated new Machine were preserved. This completes recovery of the
failed attempt, not the fresh fifty-copy execution goal.

Nineteen generic owning controls passed, including every injected-executable
mismatch, missing/mismatched independent review, source-phase crossing and
original ownership inverses. The thirteen existing message-person prestack
controls passed unchanged. These scripts already run in the normal deploy
structural gate. Root applied the sealed permanent candidate and independently
reran all nineteen controls successfully in 30.259 seconds.

This recovery boundary supports clean committed recipes whose exact Git objects
and complete immutable capture inputs remain available. Uncommitted worktree
patches and incomplete historical captures still fail closed. Fresh fifty-copy
execution and deadline proof remain outstanding; status is mitigated.

## Human feedback

The user required exact resource release, zero credit for interrupted recovery,
autonomous completion, stable CLI instructions and compact permanent regression
coverage in deployment. Preserve working setup and unrelated resources; do not
make a separate cybersecurity investigation a prerequisite.

## Reusable lesson

Bind recovery to the actual immutable source and independently reviewed execution phase rather than a historical commit or a fabricated completion receipt.

### October 6 review follow-up: external phase authority and normal snapshots

The review found that capture-local source-review metadata was the sole phase
approval authority. Three new owning inverses failed on unchanged source while
all twenty original controls passed: capture-local phase self-approval, a substituted
adjacent provenance validator, and a missing packed provenance document. A fourth normal CLI
snapshot control failed because the builder omitted the policy file. These
failures preserve the original immutable capture and do not allocate providers.

The revised helper reads the phase policy from the invoked controller's
committed Git source. Canonical helper, policy and provenance-validator bytes
must match those trusted blobs. A flat native snapshot carries the committed
policy plus its immutable controller ref and verifies the existing content
manifest before using them. Capture-local review remains an exact instance
binding, not an approval source. Source review hashes twenty-one checkout
inputs, every actual packed executable and all three boot controls; only
execution-instance provenance/configuration/ref labels are excluded from the
content fingerprint. The old immutable recipe retains its reviewed entry;
root independently reproduced the combined 39-input fingerprint and authorized
the same two pre-service phases; the existing approved recipe is preserved.

The original twenty control-method ASTs remain unchanged. All twenty-four
controls passed author and independent native replay; root replay took 77.084
seconds with all four sealed file hashes verified before and after. The
normal snapshot builder preserves both dedup helpers, the policy and the
controller ref anchor. No further full recovery suite was repeated for
composition. Combined fingerprint source review is complete; the normal deploy gates
remain pending. This repairs policy authority and source-equivalent admission,
not historical performance, interrupted-run acceptance or resource-credit
semantics. Status remains mitigated until root's final integration/outcome.

### October 7 source registration follow-up

The normal PR1440 command gate rejected the composed CLI recipe because its
content fingerprint had not been added to the existing trusted policy. The
canonical `BootstrapRecoveryTest.native_recipe` derives fingerprint
`075458631494b2dcd44a06e877ab8f4b9687d3fa1501c5bc0c07259417cb3cac`;
all 36 actual filesystem and committed inputs match independently qualified
composition `a015f2e81e989de1c1f5bc2414c0eaa6fc2f3a9a`. Root independently
invoked the same recipe and certified `before-stack-launch` and
`agent-network-index-bootstrap` in its immutable private receipt
`root-c968-native-source-policy-certification.safe.json`.

The existing forensic owner
`PreServiceArchiveTest.test_original_ack_and_absence_admit_source_bound_pre_service_endpoint`
reproduced the missing registration before the policy change. The repair adds
only that independently certified fingerprint and its two phases to the
existing table, preserving all prior entries, validators and inverse controls.
This is source qualification, not acceptance credit or a replacement for
original resource receipts. The original failed aggregate gate remains
preserved; its failed scopes require requalification after registration and
host-space recovery. The identical positive command passes after the committed
registration; the full bootstrap family passes all 25 methods. Status remains
mitigated.

Parallel failed-scope requalification exposed a separate fixture race: the
bootstrap inverse temporarily changed the real adjacent provenance executable,
so another forensic fixture rejected those transient bytes. Its original
15-method run and error are preserved. The existing negative fixture now loads
byte-identical owning recovery code beside a mutated provenance helper inside
its own temporary directory. Its rejection assertion remains unchanged.
A compact owning control forbids writing the shared executable while exercising
that same inverse: it fails before isolation and passes afterward with the
control AST and command unchanged. Production validator bytes are untouched.
Independent review verified the frozen control and source hashes, reran both
owning cases in 2.333 seconds, and confirmed shared executable bytes stayed
unchanged. Parallel requalification passed 26 bootstrap methods and 15 forensic
methods; the normal compact benchmark gate passed 480 controls with four
documented skips. The original failed aggregate and the later fixture-race
failure remain preserved. No provider calls or acceptance credit were added.

### October 7 review recurrence: direct native input closure

Review found that the complete packed executable recipe was bound, but native
configuration could append other direct injected files without changing that
reviewed recipe. Archive searches covered `direct native file set injected
recipe control` and `prestack unreviewed configuration inputs source binding`.
This is a source-recipe closure recurrence of the same owning validator, not
permission to accept an unobserved execution phase.

One permanent method in the existing bootstrap recovery family first verifies
the unchanged exact native configuration, then appends three separate control
or data paths. Original 5c1fc870 accepts all three mutants: the test fails in
three unchanged subtests because ValueError is not raised. The repair makes
that same method pass by requiring precisely the four canonical direct paths
produced by run-bench-cloud, including its canonical compressed payload path.
The original configuration still verifies; every previous method AST is
unchanged. Packed executables, provenance validation, immutable Git checks,
reviewed phase authority and exact cleanup ownership remain mandatory.

The validator belongs at the incoming native configuration boundary; a later
phase check cannot establish which extra file would have executed. No new
reviewer key, capture waiver, task, prompt, provider call or acceptance credit
is introduced. This source-bound control proves rejection of extra inputs;
normal final committed-snapshot recovery qualification and production rollout
remain pending. Private original RED, unchanged GREEN and independent-review
packet are retained under the deployment context.

### October 7 completed-primary recovery recipe registration

The completed-primary reconnect repair changed the full run-bench-fleet input
in the existing recipe. After its partial commit, the normal pre-service
preservation control correctly refused unregistered HEAD 200fe31; the original
failed related command remains preserved. Binding that same fixture to reviewed
original ccc4 passed, but did not qualify the new default source.

The actual native_recipe on an immutable final candidate Git object derives
77b2cf34137ab2fe4feda08338e9b7123f5dbeed4eedff88c6f39752ae4329aa.
Its 39-input comparison has 38 unchanged inputs and only the reconnect-only
controller change. Root independently reviewed the changed controller and
unchanged bootstrap/index paths, certifying only before-stack-launch and
agent-network-index-bootstrap in root-independent-source-phase-review.safe.json
(SHA256 f6999e60bc6223d0b1b916771b8c13c116b5b88e4321befce074bf06964f2bfe).
The existing policy adds only that fingerprint with those same two phases.
No input exclusion, source predicate, historical entry or phase is broadened.
The unchanged default related selection on committed ef4401d10 then passed all
59 controls in 36.23 seconds without a fixture override, including both
pre-service preservation controls, child-ACK/snapshot contracts and the 22
reconnect controls. Original registration RED and reviewed-source compatibility
receipts remain preserved. The parent independently confirmed source phases;
this source qualification supplies no benchmark credit or original release proof.

### October 13 native cleanup receipt recipe registration

Adding stable native identity to the local stack receipt writer in PR #1503
changed one of the 39 reviewed recipe inputs. The normal structural aggregate
correctly rejected that unregistered recipe in its bootstrap, forensic, and
benchmark recovery controls. The failed aggregate remains recorded; no capture
marker or prior fingerprint was reused to authorize the new source.

Independent review compared immutable `10f0cbfede81ed83ac2125542b60dc02b057a561`
with the prior reviewed recipe: 38 inputs are byte-identical; the sole change
is `scripts/lib/run-process-cleanup.sh` reading its own stable native identity
and appending it atomically to the stack receipt. Stack launch, signaling,
allocation, index bootstrap, and release authority are unchanged. The exact
new fingerprint is
`638c7680cd7253b354be4876456e04ac330857f79ca6423875721728eff08afb`.
The committed policy adds only that fingerprint for the same two phases,
`before-stack-launch` and `agent-network-index-bootstrap`; it preserves every
historical entry and the validator.

A new permanent method in the existing bootstrap recovery suite fails on the
previous committed policy and passes after registration. It also derives
actual separate mutated writer and `run.sh` recipes and proves both remain
rejected even when their capture-local review markers match. Four existing
forged-review, direct-input, and ref-mismatch controls also pass. Private
immutable recipe comparison and independent-review proof remain under the
Google RCA sandbox-policy-check context. This is source qualification, with
no provider calls, benchmark credit, original-owner release, or widened phase.

### October 13 native receipt consumer and helper registration

The cloud guest acknowledgement repair changes the stack receipt writer and
driver and stages the existing process identity helper in both native launch
paths. Its packed payload admits exactly one additional known basename,
`process-identity.py`; the native recipe still validates those bytes against
`git show` of the immutable source. This is a disclosed input-closure update,
not a claim that the validator is unchanged. The canonical synthetic bootstrap
configuration adds that same real packed input without changing any assertion.

Independent review of immutable candidate `7d5d507dae1b30b451eff0a64401ebc5947bc3d4`
derives source fingerprint
`380314261909483d2225acf49918d5e3d0e5b58a05a292581d6a0667793dc06d`
from 40 inputs: 21 checkout, 16 injected and three boot controls. Relative to
reviewed `638c7680cd7253b354be4876456e04ac330857f79ca6423875721728eff08afb`,
34 input entries are unchanged, five changed and the helper is newly included.
The independent finite-source audit certifies only `before-stack-launch` and
`agent-network-index-bootstrap`. Its explicit policy candidate retains every
prior entry and phase; capture-local review markers still cannot authorize an
unregistered or mutated executable source.

Private source-bound functional proof is retained separately from recipe
approval. Registration and final committed-source recovery qualification
remain root-owned and pending; no provider call or benchmark credit is supplied
by this review.

### October 13 sealed snapshot dependency closure recurrence

The next frozen canonical controller run on `71b5adb6d267a0fdfeb489eafdea6f042de3a5c0`
failed before either concurrent workstream became boot-ready. The new native
identity consumer required `process-identity.py` from its trusted control
bundle, but the fleet's explicit immutable snapshot copy set omitted it. The
unchanged real two-workstream self-test fails with exit 1 before the one-line
producer repair and passes with exit 0 afterward. A new executable public
launcher snapshot/manifest/packed-transport/helper control likewise fails
before and passes after. This recurrence is recorded in the existing PID
identity case; it adds no new receipt, phase or payload admission exception.

Independent review of immutable candidate
`c5705b1e02cdc84115b50ed52460dc97e9a67dbc` derives the exact new fingerprint
`c1606f37698d1cfe48f7beaa6c02fa78e65aaaaf8c1f0fd5c9a439c33b6cebef`.
The recipe still has 40 inputs: 39 are identical to reviewed `38031426`, and
only the checkout entry `scripts/run-bench-fleet` changes. The additional
finite policy entry must retain every historical entry and the same two
phases, `before-stack-launch` and `agent-network-index-bootstrap`; capture-local
markers remain insufficient authority. Private proof is retained in
`phase2-snapshot-proof.json` and the independent finite audit beside it.
The failed 71b Group 3 lifecycle is closed with no new Group 4; prior 4f
qualification remains historical, and final canonical qualification is pending.


### Complete-source qualification of the finite recipe registration

Candidate `cb3cb598674b1047efc92a481f1b21d42b12986b` passed all 12 canonical
Group 3 stages, including the ordered 1,795.4-second Linux controller gate
and its owning bootstrap recovery and packed-helper controls. The registered
40-input recipe remains
`c1606f37698d1cfe48f7beaa6c02fa78e65aaaaf8c1f0fd5c9a439c33b6cebef`;
all prior entries and the same two reviewed pre-service phases are preserved.
The native four-task sandbox Hub `03318d88-b85e-430a-a39d-a4e8d72073a3` then
passed all four unchanged tasks and verified its original process, archive
and provider cleanup. Final source/input qualification, review and merge remain
pending. These new results do not grant a historical failed source or a
pre-service-only canary benchmark credit.
