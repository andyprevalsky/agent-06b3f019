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

### October 13 coverage command source registration

PR1473 changed only `front-end/package.json` within the recovery recipe:
`test:coverage` now runs the actual app TypeScript check before unchanged
Vitest coverage. The complete structural gate on `56e1e7133` rejected that
unregistered recipe in its bootstrap, forensic and benchmark controls.

An independent reviewer who did not author the manifest change compared all
21 checkout inputs, 15 injected controls and three boot controls against the
reviewed `508042952` source. Both `before-stack-launch` and
`agent-network-index-bootstrap` remain unchanged and never invoke the coverage
script. The existing native recipe helper produced fingerprint
`d4f0e43fc2142ea49b82e64626efd74da443eff0b3f0eac419343c55cc867bda`.
The append-only registration in `a8793a97a` preserves every older approval,
phase predicate, ownership check and original receipt requirement.

Fresh unchanged canonical scopes passed after committed registration:
quiesced forensic 15 tests, bootstrap recovery 27 tests, and benchmark
live-results 572 tests with four existing canonical skips. All three exact
stage owners were absent at completion. Earlier failed results remain
preserved. This qualifies the two existing early phases; it grants no
benchmark acceptance credit or authority for a later execution phase.

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

### October 14 reviewed source composition on PR1473

Integrating main `9e36c9f1f` with the preserved PR1473 coverage command derives
fingerprint `a6a1b58b4d679a971332ace36d66333549c62eb87c13e7209aa92a662b671933`.
Two source audits used the existing native recipe helper without writing capture
review markers. A reviewer who did not author the coverage prefix independently
countersigned all 40 inputs: 39 match reviewed `c1606f37`, while the sole changed
`front-end/package.json` is byte-identical to the independently reviewed `d4f0e43f`
manifest. That manifest checks app TypeScript before unchanged Vitest coverage;
neither authorized early phase invokes it.

The append-only registration preserves every older entry and authorizes only
`before-stack-launch` and `agent-network-index-bootstrap`. No validator, phase,
receipt requirement, provider call or benchmark acceptance predicate changes.
Private source hashes and the non-author countersign remain with the continuation
archive. Source qualification supplies no benchmark credit; fresh canonical
recovery gates remain necessary for the integrated runtime.

### October 15 cleanup-producer source qualification

Source `f00cc265119f9df7136ec2e334872a22808a4283` changed the required-seed
bootstrap cleanup producer and therefore derived a new executable recipe:
`2d079ede1e02975732aa32b5edb5b7100f3e44662e65cd4c2acae1b1eae475ad`.
R9 correctly rejected this unregistered recipe in the forensic, prestack, and
compact live-result gates. The source comparison retains 39 of 40 bindings;
only checkout `scripts/run.sh` changes to
`5ea3bf05404417617d65088ff3016f57bb42a02c773e0afce540dc07a2ce9ba9`.

Independent review turn `01a13e71-2268-79e1-aaf8-98364408679e` reconstructed
both recipes, checked all committed bindings, and explicitly approved only
`before-stack-launch` and `agent-network-index-bootstrap`. The former still
requires the original matching ACK and absence of stack-launch evidence; the
latter requires isolated DB/index evidence with application/task artifacts
absent and rejects later cache, dependency, and tunnel boundaries. Nine focused
controls passed; the positive registration prerequisite remained blocked until
this exact entry is committed. Mutation inverses and full qualification remain
mandatory. No frontend-preflight scope, wildcard, capture-local self-approval,
receiver change, or historical benchmark acceptance is introduced.

Private trace and audit: `.context/r9-trusted-recipe-audit/proof.json` and
`.context/deploy-r9-independent-phase-audit.json`. The R9 agents domain also
exposed an older fixture expecting Docker deletion by mutable name; its existing
behavioral check now uses a foreign replacement name while requiring the captured
immutable owned ID. The same owning function rejects the old name-based runtime
and passes the current ID-based runtime; proof is retained in
`.context/deploy-r9-owned-id-test-causal.json`. Original R9 failures remain failed.


#### PR1522 absent-container cleanup recurrence: second exact reviewed recipe

CodeRabbit finding `4280661029` on `849bea2ca` identified the owner cleanup
path returning before its volume removal when its immutable container was
already absent. The actual shell producer regression failed on the original
source and passed on the fix, while bootstrap still exited 1. All ten focused
tests and eleven Docker-boundary scenarios preserve native owner PID/birth,
token and the unchanged strict receipt consumer.

The frozen patch SHA-256 is
`36c10800365ed19685e8433b205ab43a6d7dbc6289a62477cd57577acd08b69c`;
its `run.sh` SHA-256 is
`2d6ecf2f342447f9c16dce31a776a9972a920424e91dba458345d149ff13ca9f`.
A distinct independent reviewer reproduced the causal proof and reconstructed
all forty executable bindings. Thirty-nine remain unchanged. Ten composite
controls passed, including rejection of the unregistered tuple.

That role explicitly approved new composite fingerprint
`2fc56aea8ef6c70fa77e0e2778d49fccc09f5bcafb894c04f04499dfc3ee5447`
for only `before-stack-launch` and `agent-network-index-bootstrap`. The prior
reviewed fingerprints remain. Frontend preflight is not enabled. Parent applied
the frozen patch and the minimal registration after all R10 benchmark owners
had authenticated clean receipts and the local root had retired. Dirty-candidate
qualification was never claimed. Committed-source positives, mutation inverses
and fresh full R11 verification are still mandatory. Private audit evidence is
`.context/r11-absent-container-audit/`; it is not a deployment PASS.

### October 17 recurrence: browser bootstrap helper escaped the source closure

The unchanged required 47-gate run on immutable `00a422e282511a7796aa60fccc463d8868e73b2c` failed its compact benchmark-live-results, quiesced forensic retirement and bootstrap recovery gates with `executable source boundary lacks a trusted independent review`. This is an actual required recovery-control failure, not a claim that ordinary `--local` startup uses the recovery policy. The separate full agents run failed its benchmark domain; that production-livemode fixture issue is independently owned and is not repaired by source registration. All failed attempts remain retained.

Two archive searches, `trusted source recipe` and `transitive boot`, led back to this case. The Solution and Human feedback require independently reviewed immutable execution closure and forbid promoting capture-local markers into authority. The first-bad boundary recurred at recipe qualification: upstream added two stdlib-only `python3 -S` calls and a `run.sh` preflight invoking `ensure-playwright-browsers.py`; their old forty-binding tuple was correctly unregistered. Merely registering that tuple would still omit the new transitive executable from both the fingerprint and observed checkout map.

The owning local baseline bootstrap family ran 31 controls in 49.188 seconds and failed with two failures and three errors. The actual source decision separately rejected both pre-service phases against committed policy. The scoped correction uses one `recipe_paths(root, ref)` owner: the optional helper is included only when a regular blob exists at that exact Git ref; malformed/symlink entries reject. The identical path set drives native recipe hashing and captured `source_file_sha256` equality. New-helper source refs require the observed helper hash; missing or foreign values reject. Historical refs without the helper retain the original tuple, policy entries and receipt shape. Actual immutable 7f6 Git objects still derive the registered `be15598f...` forty-binding fingerprint through the new owner; this is not reconstruction of a historical native capture.

Independent source review covers the two `-S` call sites and the complete helper. The helper checks installed Python and Node Playwright revisions, can download missing browser assets and modify/prune their shared cache, and rechecks both runtimes before allowing startup. It runs after earlier DB/dependency initialization, so failure is not evidence of side-effect-free startup. Cache mutation must serialize with live browser consumers. These source/fixture checks do not establish provider absence, third-party installer descendant cleanup, or real remote capture contents. The exact new forty-one-binding fingerprint `81503fe120ff5da906b96dc6060474471d794b983e35214456be9077701b8e11` is qualified only for `before-stack-launch` and `agent-network-index-bootstrap`; every earlier policy entry remains. No wildcard, frontend phase or capture-local self-approval is added.

The original 82 assertion-call ASTs retain their multiplicity. Missing/foreign observed-helper hashes, legacy absence and nonregular helper controls pass. An initial edit did not actually add the helper to the existing mutation loop; the coverage overstatement was corrected, and the superseding test-only revision explicitly checks helper mutation through actual `native_recipe`, requiring a new fingerprint and rejection despite a matching capture-local marker. The full affected bootstrap family then passed all 33 controls in 58.976 seconds. The full quiesced forensic family passed 15 controls in 48.359 seconds on identical runtime/policy bytes. Broad compact-gate qualification then passed the unchanged complete command: 634 passed, four normal skips, 855 deselected in 364.11 seconds, exit zero. Results are cumulative across exact identical runtime/policy bytes; the only supersession after the initial green bootstrap/forensic runs adds the helper to the existing test mutation loop. Two earlier private broad attempts remain failed and retained: the source-subset attempt had 594 passes, 31 failures and nine errors; the partial static-input correction had 616 passes and 18 failures. Their traces identify missing Dockerfiles, report-format data, Prisma schema, compiler graph, Vite config and seed-cache source. No production cause was inferred from these incomplete private preparations. After all consumers joined, the complete immutable nonhistory source graph was restored once, excluding history, env files and node_modules, with existing dependency links read only and no install. All commands joined normally; no private-cwd process or recorded fixture-port listener remained. Python connect/connect_ex guards denied non-owned traffic; DNS/Node/OS egress was not independently sandboxed, so no universal external-egress or provider-allocation-absence proof is claimed.

Capture compatibility is intentionally strict: the capture-builder producing observed helper bytes was not found in the searched production sources. A historical new-ref capture lacking this field remains unsupported rather than receiving a fabricated observation. All work is a private source/policy/test proposal; current native tasks and source stayed frozen. Fresh integrated source gates, deployment and any real recovery/outcome remain parent-owned and unproven. The three named private required gates are green; this is not transfer of those results to a future committed source. This is a source-recipe closure recurrence, not an auth-task cure, benchmark acceptance credit or deployment approval.

Human instruction retained for this investigation: approval is needed only at deployment, and failures must be fixed rather than waived. No prompt, model, task, evaluator, deadline, cap, provider allocation or fixture grade was changed by this correction.


### October 17 recurrence: independently reviewed persistent-fleet source tuple

The required immutable `2a798afc5f2d3147e27af5ea488baa5d600cc48d` Group 3 run retained actual failures in bootstrap recovery (33 controls: two failures and three errors), quiesced forensic retirement (15 controls: four failures), and the compact benchmark-live-results gate. Bootstrap publication first rejected the current receipt at `require_independent_source_review`; its unreviewed-recipe negative also failed its positive registration prerequisite. The forensic positives reached the same committed-policy lookup at `verify_pre_service_archive`. This is a source-qualification recurrence, not evidence that either validator should accept an unknown recipe. The separate compact-gate stale persistent-aggregator fixture and sandbox treasury reclaim failure have separate owners and remain failed; this policy entry does not repair them.

The literal search `executable source boundary lacks a trusted independent review` and the behavioral search `bootstrap recovery trusted recipe fingerprint changed executable source policy capture helper` led back to this case. Its Solution, Human feedback, and prior forty-one-binding recurrence were read before the candidate. The owning baseline used the exact existing `test_unreviewed_native_recipe_changes_remain_rejected`: one failure in 2.973 seconds at its original positive-policy assertion. No mirrored recipe implementation was substituted. The original synthetic native capture fixture calls actual `native_recipe`; its actual return-frame `source_recipe` was retained to expose all typed bindings. Forensic fixture source directly reuses that bootstrap fixture's registry, metadata and unchanged original native config; its own unchanged positive separately failed before the correction.

Independent root review reconstructed all forty-one bindings from immutable Git source and checked their hashes and exact unelided delta against reviewed `81503fe120ff5da906b96dc6060474471d794b983e35214456be9077701b8e11`. Thirty-nine bindings are unchanged. Only checkout `scripts/run-bench-fleet` changes from `e5fbbcf2f8d9a444ba7ce3e09e9ea813ba53df38f3ef9668d427257a60da0604` to `114464e0db1f5b10486b8fc02cb1e87f4ccd890dbd57e732001216fbe149d146`, and injected `scripts/lib/cloudbench-env.sh` changes from `690c74e98d24268e6888c556b5077eb71a13d24ddcd6b06c5f6446e801129b8f` to `baa5c571470e9d5b9deb075d601ca19d90503601aadfd8f4b794bcdcab2abb18`. The new canonical tuple is `4d91213b0d069785fb5e935f440f35ddbae288d4ae9c0e0135256ad44155afa6`.

The changed source uses `python3 -S` for stdlib-only Hub metadata, realpath, listener and startup-card controls. The fleet aggregate projection now executes as one persistent unbuffered Python owner instead of restarting Python in a Bash loop; its existing per-tick projection remains inside `aggregate_tick`, ordinary errors are logged, zero-status tick exits are tolerated, the delay remains one second after each tick, and TERM/KeyboardInterrupt remain owner stops. This changes fixture lifetime assumptions; it is not an authorization to treat the persistent source as a one-shot fixture. The strict pre-stack/index phase predicates, original ACK requirements and observed source-map equality are unchanged. No new allocation authority or frontend-preflight phase is introduced by the finite registration. The policy JSON is absent from all forty-one recipe bindings, so registering the tuple does not create a policy self-hash cycle.

Only after that independent review did private committed source `f23a408b5716e7d3f46cb28fbeb74e4c288e14c4` append the exact tuple for `before-stack-launch` and `agent-network-index-bootstrap`. All 47 historical policy entries retain their values; the new entry is the forty-eighth. Runtime helpers and both owning test modules remain byte-identical to `2a798afc`; all original assertions remain. The source policy still must match committed Git, and capture-local markers cannot authorize new code. There is no wildcard, phase broadening, marker override or validator weakening.

The same bootstrap case then passed in 2.260 seconds. The complete unchanged bootstrap family passed all 33 controls in 55.126 seconds, including actual-native-recipe mutations, missing/foreign helper capture, historical closure, forged policy and snapshot-owner negatives. All 140 recorded owned process birth identities were absent after normal join. The forensic owner's same positive failed in 1.296 seconds before and passed in 1.389 seconds afterward; its complete unchanged family passed all 15 controls in 50.383 seconds. Those controls retain foreign ACK, service evidence, missing absence, changed native source, archive hash, missing provider evidence, ownership-prefix, missing worker-log and live-inventory rejection. Its private source was clean; it makes no universal independent process-scan claim. Python socket/DNS denial was used in bootstrap, and Python connect/create-connection denial in forensic; these are not universal OS-egress or provider-allocation proofs.

Private evidence is under `.context/auth-deploy/repair-final-2a798af/bootstrap-recovery-rca/`: `actual-41-binding-vector.json`, `changed-bindings-unelided.diff`, `root-independent-finite-recipe-review.json`, `candidate-freeze.json`, `full-bootstrap-proof.json` and the single-case logs. Forensic proof is `.context/auth-deploy/repair-next-primary/forensic-policy-2a798-rca/final-proof.json`. An initial RCA telemetry command used unsupported `stage=reproduce` and failed; its shell nevertheless continued the baseline, an execution-order mistake retained in the record. The corrected actual `reproduce-diagnose` event was written afterward without backdating. No prior timing hook is claimed.

These are private mechanism and source-policy results only. All original Group 3 failures, native outcomes, deadlines, model/task definitions and resource evidence remain immutable. Fresh integrated canonical verification is still required; no historical failure, native authentication task, paid replay, deployment or full Group 3 pass is inferred. Human instruction remains approval only at deployment and fixing actual failures rather than waiving them.

### October 15 PR1473 source composition after current main integration

The integrated source at `cea52afef` combines reviewed main cleanup with the
previously reviewed PR1473 frontend coverage command. A non-author reconstructed
all 40 executable bindings independently. Relative to reviewed `2fc56aea`, 39
match exactly; only the entire frontend package manifest differs, and it is
byte-identical to the reviewed `a6a1b58b` manifest. Relative to `a6a1b58b`, 39
match and the sole changed entire `run.sh` matches `2fc56aea`. Phase and provenance
validators remain byte-identical across both reviewed parents.

The finite composite fingerprint
`c6039c4e1d631c58df5999dbc5b9fc645e1984af337802ab32117465471b63dd`
is independently countersigned only for `before-stack-launch` and
`agent-network-index-bootstrap`. No later phase, wildcard, validator or receipt
exception is added. The original three unregistered-source gate failures remain
failed; fresh owning checks are required after this registration. The private
audit retains the complete binding comparisons and independent reconstruction;
its 121 archived files passed hash read-back. This source registration grants no
benchmark acceptance credit.

### October 17 source-policy recurrence and browser-preflight phase closure

The unchanged full structural gate rejected the current composite executable fingerprint3ae210539a3582e7354d727f4d2c8e33ffe2275f6e642ed9d0c577323a7530c8: bootstrap31 had2failures3errors and forensic15 had4failures. Independent reconstruction compared the40input recipe to previously registered8550670:36unchanged, changes in run-bench-cloud/run-bench-fleet/run.sh and packed cloudbench-env.sh. The source policy correctly failed closed; no environment diagnosis or capture-local self-approval is valid.

Independent review exposed a new transitive closure boundary: run.sh invokes ensure-playwright-browsers.py after index bootstrap without an intervening guaranteed rejected marker on the healthy-dependency path. That executable is outside the existing fingerprint; its current code installs/checks browser assets and allocates no task/application providers, but blindly registering this recipe would authorize future unreviewed helper changes. Root chose an unconditional marker immediately before helper execution plus rejection of that marker in the existing index-phase exclusion tuple. This retains historical recipe formats and ends the certified interval before unbound helper execution, instead of broadening executable authority.

The new permanent negative uses the valid original index fixture and marker alone, marker+diagnostics, and marker+changed-helper output. All3subcases fail on immutable original recovery code and pass unchanged on candidate. No real browser/helper execution or financial/provider acceptance is claimed. All31original method ASTs remain unchanged; full candidate bootstrap32 and unchanged forensic15 pass. Existing source-change, forged-review, immutable snapshot/policy, archive, ownership and phase inverses remain intact.

A separate reviewer independently reconstructed40inputs for private source commitc080f808367f3594498e67e60b31a920570c827e:39match b0f7 and only run.sh marker changes. It certified fingerprint96d5ca2564acdee8e4557f2d9f7415989e366776083e33c345c5ce18f4ac60da only for before-stack-launch and agent-network-index-bootstrap. Final private policy commit86953d801768dfacc292510b069f767a71acfff7 adds exactly that entry, preserving48priorentries; naked3ae210... is not registered. Trusted committed source and capture-local instance binding remain mandatory.

The parent reviewed and applied the exact four-file repair. Full structural/deploy requalification and final review remain required. Private evidence is c12-prestack-source-review-rca-local1805/output.text, result.json, commands.json, source-phase-certification.json and hash manifest; original closed logs are retained by reference with exact SHA256. No W/index/guest/provider changes were made by this worker.

Human feedback: no blind hash registration or weakened assertions. Root explicitly chose marker boundary A, preserving historical recipe format and narrowing the credited interval; no new user allowance question.

Reusable lesson: End a certified recovery interval before a newly reachable unbound executable, and certify only the exact revised source composition after independent review.
