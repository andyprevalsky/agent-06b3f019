---
id: 2026-11-10-lost-coordinator-cleanup-and-isolated-renewal-dispatch
date: 2026-11-10
title: Lost-coordinator cleanup admission and isolated renewal used incompatible authority paths
surface: harness
component: staged-deploy-native-cleanup-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native cleanup required known outer coordinator flags and clocks while accepted isolated renewal through its original failure ID bypassed latest-successor custody validation
symptoms:
  - "native cleanup reference"
  - "failed successor execution"
  - "recovered-native-execution-v1 retains UNKNOWN flags and null outer clocks"
  - "original failure-ID renewal reached direct validation while token renewal refused"
tags:
  - deploy
  - observation-loss
  - cleanup
  - isolated-renewal
  - dispatch
sources:
  - PR #1865
  - commit 431b7c4cb2aff2af425c95d0f2aedd658e843b9c
  - plan:/var/tmp/deploy-mf1108/smoke42-cleanup-protocol-candidate/preparation-proof.json
  - plan:/var/tmp/deploy-mf1108/isolated-successor42-candidate/v2/HANDOFF.json
  - plan:/var/tmp/deploy-mf1108/isolated-successor42-independent/review-final.json
repro: python3 -B /var/tmp/deploy-mf1108/isolated-successor42-candidate/v2/run-tests.py --full
status: open
---

## Problem

Native smoke42 ran on431b7c4 with source digest
a6107a35dcdc0350f86d54f05d0089be6af7f3da1f6305feef9fd87d5c631104.
The originating coordinator command reported143 without its final smoke outer
receipt. The sender, signal mechanism and actual outer wait status remain
UNKNOWN. There is no proved OOM, platform or process-sender attribution, and no
causal reproduction of that termination is claimed. The known harness recovery
and renewal defects below are separate from this open termination cause.

Exclusive journaled NONPASS settlement retained the five existing outer
receipts byte-for-byte and recorded the missing smoke receipt as FAIL,
complete=false. The actual adapter has six native PASS plus eleven UNVERIFIED,
complete=false and cleanup_complete=false; these six outcomes are evidence,
not a complete gate pass. The recovered outer case_complete values remain
false, outer native_exit/timed_out/cancelled/lingering_group remain UNKNOWN,
and outer started_at/finished_at remain null. No historical process sidecar or
supervisor wait result was invented for a route that did not own that lifecycle.

Clocks name different events: the native campaign producer summary finished
at2026-11-10T07:14:20.589133Z; the adapter finished at07:14:26.293597Z; the first
terminal observation was07:14:29.278797Z. The observation time is not a producer
finish time. None supplies a missing outer coordinator start/end or wait status.

Exact immutable native bindings are:

- request.json:2b93d801b78ef3d084e23f63504f26ab289576882cf8aaee8100cd200b6c1461
- recovered receipt.json:2be533ffdce4cd9a41bdc414d89bfbb1ef2157958c6832cb93bbefb8dccd89cc
- adapter result.json:d6fedaff877cd753a6358308550f8a5a171912d86e2af75b7a85b1ab5eb3c235
- native summary.json:7183a1c5c98bb2e1a60ecaff4a29e7619af2adbbe2a9d50f256c58a6c5224f67
- settlement-round42-journal.json:1004c43e9d35799cf568448363493b2d25ea29b41e930bda8afd62194516b312
- settlement-round42-committed.json:58f178cc80ec287bca2ace94d4cc828198c169698a84b8fb4502785a98a9dce9

## Diagnosis

The old ordinary native cleanup envelope rejected truthful lost-coordinator
facts at native cleanup reference. Replacing UNKNOWN with false, filling outer
clocks from producer times or treating physical controller absence as resource
release would invent authority. A typed observation-loss header must instead
bind the exact settled receipt/request/adapter/journal and retain their missing
facts while invoking every existing full native closure check.

A second independently reproduced boundary affected original isolated token
6428b1b8c79c47fbb0422465fec357e1. Its existing failed-successor validator requires
known false cancellation/timeout flags, integer outer exit and finite outer
clocks. Those facts are absent in42. More seriously, public reconcile routed
an already accepted isolated proof through guarded renewal only when supplied
the token without a failure occurrence. Supplying its original failure ID
6cdb0f99c0db4753a54c423cdd0f071b instead reached generic validate directly,
bypassing latest-successor checks. The first amendment still allowed this
bypass in a wrong phase because accepted-entry dispatch was phase-gated.
Copied actual-state probes reproduced both dispatch defects without live writes.

Archive searches used literal cleanup-reference/UNKNOWN/successor terms and
behavioral isolated-renewal/coordinator-observation terms. Related cases read
were2026-11-07-deploy-coordinator-disappeared-before-native-finalization,
2026-11-03-native-cloud-reconciliation-missed-campaign-recovery and
2026-11-10-cleanup-renewal-validated-historical-successor-against-current-inventory.
They describe unknown termination, known interrupted-receipt renewal and
historical inventory reconstruction respectively. This case records the distinct
exact42 UNKNOWN/null settlement admission and public failure-ID/token authority
split; it does not reuse their cause attribution or claim their fixes explain143.

## Solution

The reviewed typed campaign-observation-loss-mixed42-v1 header admits only the
pinned42 settlement, original source/token and12 launched plus5 never-started
rows. It authenticates the separate producer chronology and current exact
original process/group absence without converting UNKNOWN outer facts. The
six actual passes, first real shop failure and cancelled/unstarted siblings
remain unchanged; the nested N2 owner is a separate13th owner, never extra
main-task credit. Malformed types, invented credit, changed rows, source,
identities, missing original files and forged settlement authority refuse.

Header admission is not cleanup completion. The same full native validator
still requires all13 canonical owner retirements, exact original/mirrored
audits, provenance, resource and guest/runtime closure, Hub/relay/process and
publication custody, financial evidence and exhaustive file hashes. Current
actual validation REFUSES shop, setup and biometrics original-volume owners.
Copies, a capture attempt, billing stop, archive proposal or source repair do
not supply those proofs. No alternate forensic exception is introduced here.

The typed successor branch requires an actually accepted strict42 cleanup
entry and replays still_bound through that same full validator. It checks exact
historical request/receipt/adapter/source/token/full inventory, original6428
isolation and canonical4396c NO_REMINT custody. It uses separately named native
producer chronology, preserving outer UNKNOWN/null facts. A hypothetical entry
with the real validator still refuses current unresolved ownership. Positive
controls use explicitly SYNTHETIC strict-closure/original-obligation validation
oracles; they are not actual cleanup, benchmark or financial evidence.

Already accepted isolated proofs now enter guarded renewal unconditionally
through either exact original occurrence ID or token. Renewal owns all phase,
ready, running, live-failure and CANCEL refusals. First isolated admission stays
on its original generic path; the old generic failed-successor validator is
unchanged. The existing external make-renewal-proof.py is unchanged and requires
actual current source/plan/environment equality. It copies only validation_source
and pins original body73057ff465e9d696367f5c0eaceb0a52f8f8bed10a6bfb7abeba632d58975a26.
All20 original resource exclusions, cleanup=false, obligations-preserved and
false execution/financial credits remain. Protected4396c custody grants no
current execution or release credit; no financial debt or original FAIL is erased.

Step6a: deleting duplicated authority dispatch suffices for the failure-ID
bypass, so accepted renewals share one guard. Deletion alone cannot authenticate
missing coordinator facts: the narrow typed42 branch consumes existing native
settlement and strict closure authority instead of relaxing ordinary flags,
creating a shadow cleanup validator or reconstructing outer timestamps.

Validation of frozen successor v2cb501e93e4ce9cc327d4b9101f0b9fcdb065c52a0e3faaa4a5cb25a9a32bf3e1
and combined patch576807659c65a9849e90232cda176e30a38be6e95c902f4cb3d9ad05eabca7e1:

- Actual captured old cleanup header/UNKNOWN failed-successor checks reproduce
  refusal; candidate typed header passes while real complete closure still refuses.
- Twelve independent copied-actual public refusal controls cover both IDs and
  missing closure, wrong phase, ready, running, live failures and CANCEL. Extra
  proof keys, source mismatch, credit/type corruption and immutable input changes
  refuse without mutating native state or falling back to direct validation.
- Twenty independent selected registered owning tests pass. Five new successor
  methods exercise both public IDs and preserve original proof/exclusions/history;
  the five typed cleanup methods compose with them. All425 original test-method
  ASTs remain unchanged.
- The entire final immutable combined owning suite passes444 tests in167.909s,
  zero failures/errors, via the repro command above. The exact reviewed observer
  bytes use an external physical0644 fixture because injected shared-source0600
  mode caused four earlier diagnostic errors; no shared chmod or guard relaxation.
  Earlier runs, including a run whose files changed while loaded definitions were
  active, remain diagnostic and are not final-source acceptance evidence.

The public native cleanup/renewal result is launch eligibility only, with zero
new execution, assertion, financial-release or PASS credit. These local tests
neither establish a cause/fix for coordinator143 nor execute missing smoke checks.
Status remains OPEN pending genuine original-volume closure, actual native
reconciliation/renewal and new-source deployment gates. No full retention-test,
runtime merge, production, handoff or final archive success is claimed here.

Golden reference: not applicable; this is an operational native harness and
recovery-authority correction with no model-visible prompt or schema change.

## Human feedback

The actual user asked to finish /deploy and resume the sister thread. The
standing user instruction preserves Freedom and its protected configuration.
External-only preparation, exact-owner restrictions, zero-credit recovery,
truthful UNKNOWN clocks and independent review were coordinator instructions;
they are not represented as additional direct human feedback or corrections.

## Reusable lesson

An unknown coordinator result cannot become known through resource cleanup.
Authenticate distinct native recovery authority, and route every identity for
an already accepted obligation through the same renewal and quiescence guards.

## Follow-up: launch-only isolation after the user directed fresh volumes

The coordinator relayed the user's explicit direction to finish deployment with
new volumes rather than wait for provider recovery. This authorizes fresh,
isolated validation; it does not certify recovery or release of the three old
originals, three pending copies, old financial obligations or original test
outcomes. The earlier normal full-cleanup refusal remains correct. The native
cycle's eleven assigned-repair dispositions were imported through the supported
API, retaining their UNVERIFIED/incomplete history and the semantic post-merge
packet; no old execution became a pass.

The new path uses existing isolated-validation purpose only for exact42.
It retains raw UNKNOWN outer process flags and null outer clocks, authenticates
the original request/result/settlement/source and consumes separately named
producer clocks. The common13-participant validator and existing isolation
body remain authoritative. Actual raw provider responses and original native
one-shot fork intent/result/HTTP seals bind all three copies to their exact
retained originals. No active Machine, attached copy, mismatched source/nonce,
unknown identity, changed raw hash, extra proof field or positive credit is
accepted. The result excludes14 old Machine/original-Volume pairs plus three
copy-Volume-to-original-Volume links in distinct typed maps. The original6428
flat20-resource proof body73057ff465e9d696367f5c0eaceb0a52f8f8bed10a6bfb7abeba632d58975a26
and4396c canonical NO_REMINT/false-credit custody remain unchanged.

Two actual replay boundaries required explicit native authority. The last
participant had a positively sealed not-allocated-verified row, not an allocated
Machine with an empty ID. Exact original row/expected-fresh intent, independent
native audit seal and mirrored provider-verification epoch, empty native ID
index, original terminal projection and absent allocation artifacts authenticate
that row without inventing an excluded Machine. The pinned original producer
checks complete native clone-name absence before publishing that seal. Unknown
or partly allocated empty rows still refuse.

The relay's37 JSON files are intentional terminal journal records:28 closed
and9 abandoned, with zero live lease files. Native retire() removes live markers
and joins routes but preserves JSON; there is no prune API. The old guard
mistook retained evidence for consumers. The isolated42 branch authenticates the
exact37-record inventory/authority seals, mirrored bytes, native broker shutdown,
original relay-owner retirement and absent sockets. It preserves every record
and does not signal or require retirement of an unrelated/global lease-client
PID such as717. The ordinary full-cleanup empty-directory requirement is
unchanged. Active, extra, malformed or mismatched records refuse.

Future renewal also keeps42's outer finish null. An authenticated isolated42
origin helper replays the accepted prior proof and uses its separate producer
boundary for both complete and normally reconciled failed successors. Future
native canonical and mirrored allocation audits are rehashed before checking
that no new Machine or Volume overlaps any old original or copied Volume.
A blank future row needs its positive native not-allocated disposition and
expected intent; it cannot disappear through a generic empty-ID filter. No
allocation mode, task/evaluator assertion, timeout, policy floor, concurrency
setting or model-visible scope changed.

The actual full proof, serialized to an ordinary JSON dictionary and replayed
through the same unmodified validator, passes728 file bindings and all13
participants. Proof SHA256 is
b5e33f9f3fa1ec7bd03376bfad5db242bafe9287eea102138c8f1561ac5b7416.
The result is isolated launch eligibility only: cleanup_complete=false,
credit_granted=false, execution_credit=false, financial_cleanup_credit=false
and obligations_preserved=true. Native state was unchanged. Normal full cleanup
still refuses the unresolved owners; a missing lineage packet, positive financial
credit or normalized outer clock also refuses. This is not canonical admission,
a benchmark execution result, provider recovery or financial settlement.

Frozen candidate native17c2b8d69c988b2642af2afa4076498a4399352e521b8df71951eb9a50accc97,
protocol07b5c295be72addd1a633dee4db67863a53d1db1d1ae3d1c179fc77105e95dee and
patch5045ae2321f16ad66f5b5bbf80dfa1d28c855c2af6876dc9ba6f146470a25b03
passed the entire450-test owning suite in171.983s with zero failures/errors,
using the same external exact-byte0644 observer fixture described above.
All435 methods already present in the previous integrated suite remain
AST-identical; six new methods cover strict isolated fields, separate clocks,
typed successor debt, both later-successor chronology consumers, actual native
allocation-audit disjointness and zero-allocation refusals. Additional actual
provider/lineage and terminal-relay tamper controls independently refuse changed
custody, active/extra records and mirror or authority corruption. Earlier
module-import harness errors and progressively exposed real admission refusals
are retained separately; none counts as a successful native run.

Evidence: plan:/var/tmp/deploy-mf1108/isolated42-fresh/v2/FINAL-PINS.json;
plan:/var/tmp/deploy-mf1108/isolated42-fresh/v2/full-owning.log;
plan:/var/tmp/deploy-mf1108/isolated42-fresh-lineage/actual-isolated-proof-v2.json.preparation.json;
plan:/var/tmp/deploy-mf1108/relay37-readonly-20261110T235358Z/COMMAND-PROPOSAL.md.

Status remains OPEN pending canonical native isolated admission/target renewal,
fresh-source required gates and deployment. No cause or fix for coordinator143,
recovery of any missing original runtime, financial release, normal cleanup
completion or new benchmark PASS is claimed. Golden reference remains not
applicable to this operational native harness change. The fresh-volume direction
is the additional human authorization; the precise external-only preparation,
review and preservation constraints remain coordinator instructions.
