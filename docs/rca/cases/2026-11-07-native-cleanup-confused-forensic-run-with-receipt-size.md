---
id: 2026-11-07-native-cleanup-confused-forensic-run-with-receipt-size
date: 2026-11-07
title: Native cleanup treated a complete forensic run as a small transport receipt
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native cleanup applied its ordinary 64 MiB receipt reader to a 99,297,775-byte original run record containing forensic logs
symptoms:
  - "native cleanup: proof file too large"
  - "native artifact: raw file byte bound exceeded"
  - "native artifact: materialization bound exceeded"
tags:
  - deploy
  - cleanup
  - evidence
  - bounded-parsing
sources:
  - PR #1708
  - commit b93150574e7b7d7e0d7a11170db65c9c8305a0a3
  - commit 4a0623371f8814da22b48e16522dcd2181e782d0
  - commit 77744c54e7da30fd57c8b1c3295b9f9c70249fd5
repro: python3 scripts/tests/deploy-test-plan.test.py NativeRunArtifact
status: open
---

## Problem

A failed nine-task deployment cohort retained a complete original run JSON of
99,297,775 bytes. Its ten participant run files totaled 133,853,038 bytes. The
cleanup verifier required those exact bytes but also rejected every proof member
above the ordinary 67,108,864-byte receipt limit. Consequently neither preserving
the original record nor supplying complete native retirement evidence could
make the next launch admissible.

## Diagnosis

The same unmodified 495-file proof failed on the canonical bounded reader at
`b9315057` with `raw file byte bound exceeded`. This was an evidence-consumer
contract mismatch, not an application failure or proof of a provider outage.
The run combined small control metadata with large forensic log subtrees;
materializing the entire document as a small receipt was the wrong interface.
Trimming logs, rewriting original results, or excluding the file would conceal
the original evidence and was rejected.

## Solution

Read native participant run records through a regular, canonical, non-symlink
descriptor in 64 KiB chunks. Verify the complete original hash, JSON grammar,
UTF-8, decoded duplicate keys, and pre/post descriptor and path identity. Only
the explicitly recognized forensic log subtrees receive opaque references;
control and unknown metadata remain bounded and materialized. Cancellation and
an existing caller deadline remain authoritative. Recovered runtime/payment
documents retain their existing full validation.

Keep the generic raw, ordinary receipt, metadata and scalar limits at 64 MiB.
The explicitly directed forensic path admits at most 128 MiB of participant run
bytes in aggregate, charged from each verified descriptor before reading. This
is an I/O/materialization accounting contract, not a hard 64 MiB process-RSS
promise. Isolation revalidation retains the same exact file set and hashes.

The full planner suite passed 68 tests, including shared-budget exhaustion and
malformed-budget controls. Existing guards cover wrong hashes, malformed opaque
JSON, duplicate keys, large control metadata, FIFO/symlink input, cancellation,
deadline expiry, and concurrent truncation. The cycle and CLI/review suites
also passed. On the canonical repaired verifier the original proof validated
all 495 bindings, ten participant fleets and ten retirement audits; normal
reconciliation then succeeded without changing any original attempt or failure.
The proof SHA256 remains
`895cb94dc2f18052486f12a6446ac70b865f6d2b2bddbdf53f0054e6f0ae9b01`.

Evidence is retained under
`.context/rca-browser-4f77/relentless-strict64-integration/` and
`.context/rca-browser-4f77/authorized-internal-unblock-1812/`. Acceptance is
launch eligibility only: all 312 historical failures, the original nine
UNVERIFIED outcomes, retained Hub custody and financial liabilities remain.
It does not prove current-source smoke, production deployment, fresh provider
state, or settlement of any historical obligation.


## November 7 recurrence: transient opaque-key accounting

Review finding 4503659936 was reproduced on frozen 77744c54e7da30fd57c8b1c3295b9f9c70249fd5. The reader method ASTs are identical to b9315057 and 4a062337: this is a limitation of the prior bounded-parser repair, not evidence that a later source sync introduced it. The older main b365 and original 0d3 have no deploy_test_run_artifact.py; do not infer a NOT_INTRODUCED result against those baselines from the narrower comparison.

Inside tasks[*].logs and tasks[*].owned_roots[*].logs, objects are parsed with keep=False but their decoded duplicate-check keys and set growth were charged forever. Sibling objects are already dead when the next one parses. The counter therefore measured cumulative allocations rather than simultaneously live metadata. A valid 24,040-byte document with 3,000 tiny log objects fails through the normal read_run_artifact entrypoint at its unchanged 4,096-byte metadata limit. With the ordinary 67,108,864-byte limit, a 5,000,041-byte document also fails: the old charged total reaches 67,108,979 on the owning Python 3.11.9 despite low live parser state.

The minimal correction snapshots materialized when a non-retained container opens and restores that value only after the complete container closes. Nested scopes preserve the charges for every still-open ancestor key set. Retained scalars, objects, values and opaque references retain their existing accounting. No byte limit, scalar/depth rule, parser grammar, hash, FD identity, cancellation or deadline check changes.

The identical owning reproduction exits 1 before and 0 after. All 18 NativeRunArtifact tests pass, including all 13 original tests and five additions: sibling objects on both opaque paths, giant single/live nested key sets, decoded duplicate or malformed opaque tail after many siblings, and retained scalar accumulation. The owning deploy-test-plan gate registration is unchanged. This focused owning class is not a claim that the full planner or entire deployment gate passed.

At the ordinary 64 MiB limit, the same 5 MB reproduction passes after the fix with a peak charged state of 1,433 bytes on the owning Python 3.11.9 (the host Python 3.12 check measured 1,337). That is instrumentation of the existing accounting counter, not a process-RSS measurement or new budget. Read-only compatibility replay verifies all 495 original file hashes and parses all ten native run files, totaling 133,853,038 bytes, through the unchanged 128 MiB aggregate allowance; the largest original file remains 99,297,775 bytes and the remaining allowance is 364,690 bytes. The unchanged public native validator also accepts the existing 495-binding normal proof, returning ten participants, ten audit seals, one retained service and credit_granted=false. No canonical reconciliation, failure projection, resource, financial debt or test credit is changed.

The candidate and permanent tests are private under .context/rca-browser-4f77/review-findings-2109/artifact-child. Source and test patch hashes, exact commands and before/after logs are supplied there. This case is reopened only for the bounded-reader recurrence pending required source-bound gates and deployment. The prior raw-evidence repair and all its original evidence remain recorded above. The fix is O(1) additional accounting per container, adds no provider/network/DB work, and does not change deployment concurrency. Golden reference: not applicable to this ordinary parser/owning-test correction.

## Human feedback

The user directed autonomous resolution after the internal file-size limit was
explained. Cloud/test capacity, width, timeouts, tasks and assertions remain
unchanged. The file-reading allowance is unrelated to a spending budget.

## Reusable lesson

Separate control receipts from intact forensic payloads. Bound both explicitly,
verify all original bytes, and preserve historical failure projections even when
later evidence permits a new launch.


## November 9 recurrence: retained acceptance replayed under a newer budget

After PR #1865 source sync to `a8edc990749756a76ea286ea4ca6426a555a1718`,
`prepare-historical-no-retry` refused with `smoke: original isolated-validation
obligation changed; refuse launch/completion`. Calling the swallowed validator
directly exposed `native artifact: aggregate raw admission bound exceeded`.
The original accepted operation binds 18 participant run files totaling
274,416,973 bytes. Its unchanged provider-pair observations, native files and
proof remain valid under the exact accepted source-52 validator; that replay
returns an identical entry in 3.17 seconds. The new 128 MiB fresh-proof budget
is correct and is not increased.

The first bad boundary reapplies a new proof-admission budget to an already
accepted retained obligation during source renewal. This is an integration
contract regression, not fresh execution evidence or proof that the original
cleanup became complete. There is no narrower ordinary terminal proof: the
original campaign's participant closure and all debt files remain mandatory.

Retained recognition and source-only renewal now replay an explicitly versioned
original obligation contract. Bootstrap requires both the fixed known verifier
blob SHA256 and an independently pinned acceptance-body SHA256 bound to its
original validation source. Git reads disable replacement objects and bound
verifier code to 1 MiB. Only that exact allowlisted code executes; arbitrary
proof-selected old revisions cannot select a validator. All native file hashes,
receipt/owner/source facts and provider retirement checks still run. A durable
marker keeps the original code and body anchors across later source renewals;
only `validation_source` may vary. Fresh `validate` and `reconcile` admission
remain unchanged and always enforce the current 128 MiB aggregate budget.

The permanent retained-obligation regression is RED on a8ed (`still_bound` is
false, 0.727 seconds) and GREEN with the correction (1.734 seconds). The existing
aggregate-budget test and a fresh-proof forged-contract negative control pass
unchanged with the focused three-test run. Independent controls reject changed
acceptance bodies, file hashes, owners, sources, native receipts, malformed or
changed markers, and non-integer versions. The physical 18-file proof passes
recognition, historical no-remint preparation and renewed recognition without
changing any original native file or provider fact. `cleanup_complete=false`,
`credit_granted=false` and `obligations_preserved=true` remain explicit. Full
coordinator and final source-bound deploy validation are tracked separately.

This migration is control-plane work, not per-agent runtime work: at 10,000
agents it adds no channels, sessions, network calls or database operations to
agent execution. It neither admits a new paid fleet nor grants test, assertion
or financial settlement credit.


## 2026-11-09 source-target renewal follow-up

PR1865 source5510 round29 smoke failed before dispatch at
`isolated_request`: `native cleanup: next source/inventory binding`. The
retained original operation still targeted52b7cc41/f2ac while the newly
frozen request targeted5510f010/4e9b. All18 original task names remained
in the inventory. Only request.json existed: no adapter, output, receipt,
process or native campaign was created. All18 UNVERIFIED outcomes remain
in the original attempt; none is a failed executed task or a PASS.

Native renewal then failed at `failed successor execution` because the latest
coordinator-only refusal hid the actual complete round23 successor. That
successor also legitimately marked the historical AgentCard NO_RETRY_CUSTODY
case as unexecuted, whereas the cleanup-successor validator required every
case_complete flag to be true. Both barriers are reproduced on immutable
state copies. Gate: INTRODUCED by deployment integration without renewing
the source target; the recovery defects are repaired in this deployment.

The narrow historical-refusal compatibility binds original operation6428b1...,
round29, the exact recorded refusal-row digest and independently reviewed
request SHA7d65926e... . Only this exact witnessed refusal may be traversed
when finding the last real execution. Its canonical directory must contain
only the same request, without an admitted-isolation field or native root.
Unknown refusals, changed tokens/bytes, output/process artifacts and later
executed or incomplete results still block; no attempt is erased. The last
real successor still undergoes the full existing native closure validation.

A NO_RETRY_CUSTODY omission remains SKIP/current_execution UNVERIFIED and
case_complete false. It is accepted as historical debt only after its native
obligation exactly matches canonical custody history and the recorded
source/environment/input binding. All credit fields must be actual false
booleans; ordinary incomplete checks and numeric impostors are rejected.
Neither execution nor financial/cleanup credit is granted.

The exact real18-check renewal and admission passes on an explicitly offline
quiescent projection; the live independent round30 was never mutated. Two
permanent deploy-test-cycle regressions cover the witnessed-refusal boundary
and custody omission, with token/artifact/executed/ordinary-incomplete and
forged-credit/source/history negatives. Independent review additionally ran
21 boundary controls. Production application must wait for a real quiescent
boundary. After any new freeze, refresh the native plan with current custody,
run only through the pending quick-to-triage boundary, generate a proof that
changes only validation_source to the actual frozen HEAD/digest, and native-
reconcile it before reexecution/focus can launch cloud smoke. No reset or
manual cycle surgery is authorized.


### Followup: partial zero-allocation campaign after cleanup-reserve refusal (PR1865)

On source bd64033af812958f8d89d58532f9686af5a356cb, native smoke round32 scheduled17 tasks at live provider width15. Six launched controllers refused the unchanged physical cleanup-reserve floor, nine admitted controllers were cancelled through owned teardown, and two scheduled tasks never launched. The exact native admission predicate reproduces9 admitted/6 refused at observed6831MiB; width8 admits8 with the same512MiB preferred reserve/256MiB headroom/32MiB minimum. These causal predicates match inherited main; reducing supported ambient concurrency preserves all17 tasks and every floor.

The coordinator's identity/inventory error was triggered by cleanup_completefalse; request/result identities and17-case inventory matched. Native controller execution remains FAIL/native_exit1, all17 task outcomes remain UNVERIFIED, and historical abandonment remains a zero-credit custody SKIP. All15 immutable mirrored/native ownership scopes are empty and sealed, all9 native Hub owners are retired, and relay/controller/publisher closure is independently verified. No task or provider allocation was observed; this does not convert the failed execution into PASS.

The generic cleanup reader previously required an integer controller exit and parent handle for every scheduled job, rejecting the two legitimate null unlaunched rows. A separate versioned layout admits only the independently witnessed request/receipt/adapter/summary and immutable producer hashes. It validates every launched owner/audit, positive reserve-refusal or cancellation boundary, exact two never-launched rows, current process/Hub absence, zero allocation, original publication and full evidence closure. It records launch-only cleanup retirement with no test or financial credit and requires all17 task checks to execute again. The original retained isolated obligation is unchanged; its existing failed-successor renewal path recognizes only this fully revalidated typed entry for the original obligation token.

Validation: actual unchanged reader rejects this proof as unsupported; candidate native reconcile succeeds on a copy while preserving attempts/failures/pending and original debt. Permanent regressions reject launched identities or broken-symlink logs in null rows and unwitnessed requests before native reads. Independent real-proof tamper controls cover allocation, provenance, Hub/relay/process reuse and coupled renewal entry forgery. Full current-source native smoke and resource closure remain mandatory after supported environment/source refresh; diagnostic admission modeling grants no acceptance credit.

## November 9 recurrence: proof aggregate versus per-run admission

PR1896 retained all thirteen original parent runs and its linked canary. Their
verified original run files total 212,366,375 bytes. Each fits the existing
128 MiB per-run forensic bound, but the shared 128 MiB proof counter rejects
the complete cohort before native custody validation. Omitting participants or
rewriting logs would conceal required evidence.

The correction gives native cleanup a separate finite 512 MiB proof-wide raw
I/O allowance. The per-run 128 MiB cap, ordinary 64 MiB materialization/scalar
bounds, 64 KiB streaming, complete JSON/hash/descriptor verification and every
variant/source-pin/custody predicate remain unchanged. Standalone readers still
default to the original aggregate allowance. This is not a task, timeout,
coverage or concurrency change.

The same registered real two-by-65-MiB log-array test fails on the original
aggregate guard and passes after separation; individual scalars remain 1 MiB.
Aggregate exhaustion, per-run exhaustion, malformed/trailing input, hash drift,
standalone defaults and scalar bounds remain negative controls. Independent
review cleared exact diff 074e6eda07b8450a111915275d1ef2c17ec58c0d3bfcc69395493c221406b5ee.
Evidence is retained privately under .context/deploy-pr1896-continuation/smoke-rca/aggregate-candidate.

A pure replay validated all fourteen participants with credit_granted=false,
cleanup_complete=false and obligations_preserved=true. It neither reconciled
the live cycle nor cleared financial, browser, guest/runtime, provider or Hub
custody. Required frozen-source gates and production acceptance remain pending.


### November 10 recurrence: main-sync fixtures retained obsolete admission inputs

The first actual semantic/structural sweep at merged source b64a017c94fbac59324191780a82fec5afcf1432 ran421 deploy-cycle tests and emitted two errors plus two failures. The branch's two failed-canary fixtures still named the physical run directory canary, while inherited main now verifies the native controller PID from the numeric run-ID suffix. Two retained-obligation/fresh-proof negative controls still patched the per-run raw cap to simulate aggregate exhaustion after upstream separated the proof-wide allowance. This was introduced by integrating both repairs without adapting these branch fixtures to the resulting native contracts.

The exact four existing owning tests reproduced locally: RED (two invalid literal for int() canary errors and two missing expected aggregate-bound refusals) in1.498s. A fixture-only correction uses a valid unused numeric-PID native runID and updates its lifecycle/audit/log/proof identities consistently. Aggregate controls patch the actual proof-wide MAX_RAW_RUN_PROOF_BYTES to the unchanged total-minus-one boundary. The same four-test command then passes in3.480s. All assertions, expected messages, resource bounds, producer guards and deadlines remain identical; the production validator is unchanged. Current-source full deploy-cycle and native structural revalidation remain required. No original cycle receipt, failed history, custody debt or execution credit was altered by this preparation.


### Native validation of the November 10 fixture integration repair

The exact frozen repaired source1c47a9131d750ab72c2a756adc5ba12aa5c3667e completed native attempt36 deploy-command-structural with PASS, complete=true, native_exit=0, cleanup_complete=true and reused=false. The full owning deploy-test-cycle suite ran421 tests in143.010s and passed (native structural unit143.29s); all117 structural progress units passed. This is fresh native execution of the corrected fixtures, separate from their earlier private four-test RED→GREEN and421-test scratch validation.

The current source-bound native receipt SHA256 is1fbc1c52bd55b4e5fa7d44116e0c0d39ce9157c0a7779c31ed9e33c080e25c61, adapter/result SHA25632ad5e9a61c2630a115902f957b23429afadc91386d29d80f99a29e7a4dd5408, and authenticated downloaded structural-log SHA2563fe4c32be8fceb7e65637ec47977d8135fc37f774a490d6eed264d1b27293ba2. Evidence remains under .context/deploy-pipeline/attempts/36/focused/deploy-command-structural/ and the private native36-pass.json closeout receipt. Original attempt34's four native failures and all historical financial/cleanup obligations remain unchanged. This validates the owning test-fixture repair on1c47 only; a later main-sync source still requires its own supported native verification.

At subsequent frozen source2390845cf087491b96e4d8ea83d16188f80f64bd (source digest50294f07e9b4952dc3a9b4b8501c9ed05cc6a30f10ed68a820fe6b7769a82ebe), actual native structural attempt38 ran all429 deploy-cycle tests: unittest OK429 in112.764s, owning unitexit0/112.95s. This includes the three newly inherited historical-inventory renewal regressions. The outer structural gate remained FAIL/UNVERIFIED because its separate durable-service fixture unit failed; no whole-gatePASS is inferred from this unit. Native aggregate log SHA-25646907af704fcc1215ae2178b8e36d1944bcbcf4d5b7f751f8ae17dacb05487d3 and source-bound receipt/result references are retained in /var/tmp/deploy-mf1108/rca-durable38/native38-dtc429-pass.json. Historical421-test1c47 evidence remains separate. Original custody, cleanup and financial no-credit obligations remain unchanged; future actual-source gates and production acceptance remain required.


### Round38 followup: eight-started campaign closure

Smoke38 cleanup-only admission gap (distinct from capacity cause): native run20261110-035121-1793297 fails3.714s at cleanupreserve ENOSPC before provider mutation; infra-stop1/17 cancels7launched and9neverlaunched. Aggregate17UNVERIFIED/cleanupfalse remains original. Existing typed cleanup validators pin prior10alllaunched or15launched/2unlaunched captures, so current8launched/9unlaunched cannot obtain cleanup-only admission despite retired exact resources. New separate actual38 capture-bound validator retains all original lifecycle/provenance/outcomes, exact8rawnative hashes/4historical producer hashes/request/receipt/summary/owner/auditmirror/zeroallocation/native terminalHub/relay/publication/process guards. Actual replay8participants5Hubowners140boundfiles,0execution/financialcredit PASS;11malformed/missing/live/allocation/unlaunched controls refuse;8owningDTCtests PASS4.033s. No native action executed by RCA. Root applies reviewed extension and actualtyped reconcile for original cdb922863225412dae565d03a8b28cf1; nativefresh execution stillrequired for17cases. Capacity causalcase stays separate under rca-smoke38-admission packet; no duplicate case decision or cleanupfalse/financialcredit relabeling.

Parent integration: the exact independently reviewed cleanup extension was applied after privileged checkout-quiescence proof. Actual native reconcile for occurrence cdb922863225412dae565d03a8b28cf1 accepted the140-file proof at the original239source boundary; it records separate owner reconciliation and preserves original17UNVERIFIED/completefalse/cleanupfalse outcomes, credit_granted=false and financial_cleanup_credit=false. The applied-source owning regression command passes all8 selected old+new tests in4.197s. All17 incomplete occurrences were routed through native assigned-repair triage, never waived; fresh native execution remains required. No original receipt or lifecycle flag was rewritten.


### Round40 followup: current-producer partial campaign closure

Actual native attempt40 on d866e364d492f120da86cae905de3e75c74a8583 stopped
when a nested N2 probe could not reserve cleanup disk. Its unchanged campaign
has eight launched parents, two linked nested probes, nine never-started rows
and seventeen UNVERIFIED checks. The separate capacity/scheduling investigation
owns the cause of that native failure; this recurrence addresses only the
subsequent cleanup admission boundary. Prior capture-specific layouts correctly
refuse this new source/request, and ordinary campaign-v1 rejects its genuine
NULL unstarted exits as `native cleanup: campaign terminal jobs`.

Gate: NOT_INTRODUCED for this cleanup-contract boundary: replaying the same
original40 capture against exact main f8c8255003d70ac639facf623b30397d62baf38a
and d866 returns that identical terminal-jobs refusal. The absence of a general
partial-campaign contract is inherited; earlier branch capture-specific debt
validators remain correctly restricted. This does not waive this assigned fix
or attribute the separate resource-capacity failure.

The bounded correction reuses the existing normal validator with a typed
native-unstarted-campaign-v1 sub-contract. It admits only the reviewed immutable
dispatcher protocol, ordered complete request inventory, exact native unstarted
row schema with four explicit NULL timestamps/exit fields, absent native
identity/logs and positive recorded infra-stop. Every launched parent and both
nested probes still require exhaustive monitor linkage, bounded run projection,
source/task-matrix authority where produced, sealed mirrored canonical provider
release, zero allocated task artifacts, exact current process/Hub absence,
relay-consumer retirement, publisher and supervisor closure. Missing rows,
positive unstarted execution claims, invented exits and numeric credit values
refuse. It grants no test, assertion or financial credit and leaves every
original result, lifecycle and cleanup flag unchanged.

Actual immutable capture replay is RED on the original validator and GREEN
twice on the candidate with all ten participants and177 file hashes frozen.
Fifteen actual-proof mutation controls reject foreign source/nonce/dispatch,
coherently changed NULL rows/inventory/provenance, either omitted nested probe,
nonempty allocation scopes and missing guest cleanup. Three permanent owning
regressions preserve producer NULLs/outcomes and reject truncation, launched
identities, symlink logs, unsupported protocol and credit claims. Twelve existing
historical/canary/publication/aggregate controls also pass unchanged. Independent
review separately reproduced full-validator truncation/positive-claim negatives
and verified the six historical debt/successor function ASTs unchanged.

A diagnostic in-memory copy of the actual cycle accepts native reconcile,
still_bound and the unchanged original6428 failed-successor selector while
retaining original attempts, failures and all seventeen pending occurrences.
This is not actual native reconciliation or acceptance credit. Operational
application, native original-source reconciliation, fresh frozen-source
execution of every required check and completed production remain pending.
The initial full434 local suite exposed four unchanged backend observer-mode
errors because this prepared host's audited source is0600; an exact-byte0644
external source copy resolves the same four tests without changing any guard.
Final full-suite outcome is recorded separately in the source-bound repair
receipt; no PASS is inferred from partial output. No incident-specific human
feedback was recorded. The user's standing Freedom protection remains in force.

### Actual native structural verification on d866

Frozen source d866e364d492f120da86cae905de3e75c74a8583, digest e76b4db63f57fcb3e4ab7ee99b0f8bdd2dc5a292615c25afb7ef11cdca7fbaa8, completed actual focused structural attempt40 with PASS, complete=true, native_exit0 and worker cleanup_complete=true; no retained cleanup owner.

The original registered deploy-test-cycle unit executed431 tests in102.942s (unit103.12s), exit0/OK, skipped0.

The original registered run-bench-durable-service unit executed5 tests in8.01s (unit8.07s), exit0/OK, skipped0.

The original registered deploy-test-semantic unit executed21 tests in2.745s (unit2.81s), exit0/OK, skipped0.

Exact native receipt SHA-256 e52011045e8a2c4f190d0f4457528cc0428027e80491c02665693256a847c9c3, result SHA-256 81cbcf06734684a789f2033311892957009ad91a92c5c9ca782c8d9ec06f75c8, fetched original aggregate log SHA-256 45b3c6eb0813af99ddb3fcc9422f25ab951c145f92db214f1a9b2a9508a3941c. Source-bound original paths and complete unit counts are retained in /var/tmp/deploy-mf1108/native40-structural-verification/native40-verification.json. This verifies the repaired owning fixtures, parser tests and deploy-cycle regressions in the actual frozen-source full structural gate. It does not relabel the original native38 FAIL/UNVERIFIED, its retry, older421/429source results, actual semantic UI outcomes, original isolated cleanupfalse/financial debts, or future whole-deployment/production acceptance. All remain separately recorded.

Parent integration at2026-11-10T05:27Z: reviewed code was applied at verified native checkout quiescence. The exact current177-file proof was accepted by actual native reconcile for a2c28d7f46da40699a6f091e506dc7a6 against the unchanged d866 attempt40. Separate owner closure retains all17 original UNVERIFIED/completefalse/cleanupfalse outcomes and all credits false. Actual native assigned-repair triage accepted all17 entries, yielding needs-focused-plan/pending0 with the one separately accepted semantic postmerge packet retained. Actual applied-source15owning tests PASS3.543s; external full434 PASS163.790s using the documented exact-byte external observer setup. Fresh source/environment-bound full gates remain required. No source result, exit or lifecycle was rewritten.
