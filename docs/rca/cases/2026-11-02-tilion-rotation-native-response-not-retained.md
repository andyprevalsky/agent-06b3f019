---
id: 2026-11-02-tilion-rotation-native-response-not-retained
date: 2026-11-02
title: Tilion pooled-IP rotation acknowledgement was mistaken for no exit movement
surface: back-end
component: tilion-rotation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: tilionRotateInPlace and assembleRotationResponse required brand-new allocation even for an acknowledged same-session move to another pooled exit
symptoms:
  - FAIL live Tilion provider parity
  - carried_state_required
  - Tilion rotate-ip did not allocate a fresh exit
tags:
  - tilion
  - browser
  - proxy-rotation
sources:
  - PR #1663
  - PR #1662
  - commit 7be0644bb164763af1526ead7b426e2d5e909f4a
  - commit 067495d51582f3946d5a5b980ccc8416b66dff02
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - plan:/var/tmp/staged-deploy-implementation/.context/deploy-pipeline/rca/c66eb1133bd641edadd3d117273cdb2d.json
repro: back-end/src/tests/blackbox/browser-provider.tilion-contract.support.ts assertTilionRotationResponseContract
status: fixed
---

## Problem

Occurrence c66eb1133bd641edadd3d117273cdb2d ran backend coverage on frozen
067495d51582f3946d5a5b980ccc8416b66dff02, digest
b903608660c4e2a99a9025b2968240d9d908137d405c0479ff385de092031da1.
Native exit was 1. Shard 2 recorded 120 passed, 1 failed, 0 not run, 121 total;
browser-provider failed in 181943ms. Domain output has 54 PASS, 1 FAIL and
2 optional SKIP markers; these are marker counts, not nested assertion counts.
Shard 1, units and the standalone FPS probe passed. Later cross-provider cases
continued after the failure, but later assertions inside the failed parity
function did not run. The merged c8 threshold check and trailing teardown
test did not execute. Worker cleanup_complete=true proves process cleanup,
not execution of the teardown test.

## Diagnosis

At the initial c66 investigation, attribution was UNKNOWN and no provider-outage/credit exception was established. Later captured-response evidence below establishes the owned rejection boundary; original raw fields remain unknown. Original native log SHA256 is
d1603fba9aa450d30a74f9bedaea68213e50c1620771e57e969fcbf883886285;
server SHA256 is 0be6990bd2028133cbbcf586ec2d0fff10a6f6c787e152f8b8356b4948d7812d.
Task 25a6fd07-8fe1-5925-b6b8-551746d2a214 used native session
sess_a651ef45b2d74d50a99a781e37c22185. At 20:59:04.360Z, rotate-ip returned
HTTP 200, request ac23e87649a6443d, 2663ms. The next line reports rotated=true,
freshAllocation=false, region=us-east-1. Replacement sees a live session with
no carried state and returns typed 409 at 20:59:04.391Z; domain line 663 fails.

The false log value is response?.fresh_allocation === true evaluated false,
which cannot distinguish absent/null/nonboolean from boolean false. Worker A
searched the original retained bundle, coverage-failure archive, coverage logs
and matching cache: no raw response/full headers or session-specific before/
after IP values remain. The pre-IP was an unlogged local variable, and the
failed POST prevented the post-IP read.

Adapter, replacement and mapper are byte-identical on confirmed baseline
6f3f53201faac3a3e70de099e7c211cee6770fad and frozen head. In the private root,
RCA_REVISION=head node --import tsx replay.cjs and
RCA_REVISION=main node --import tsx replay.cjs both exit 1 with 409 !== 200.
The real functions reproduce that refusal for false, missing and nonboolean
fresh_allocation variants. These are explicitly synthetic projections of the
retained normalized evidence, not original provider bodies or a repaired run.

Archive searches: carried_state_required (no hit); Tilion rotation fresh exit
(related cases). The October 28 same-native transport case had both freshness
flags true and failed at response assembly with HTTP 500. This fails earlier
with false-normalized freshness and 409: no common cause is established.
Archived API docs and the current public OpenAPI both define no request body
for rotate-ip; no speculative body flag is justified.

## Solution

PR1663 repairs both acknowledgement boundaries. The low adapter requires
`rotated=true`, an explicit boolean `fresh_allocation`, and the exact native
session ID. It preserves false allocation provenance rather than claiming a
brand-new allocation. The response assembler accepts either explicit boolean
while preserving all before/after session, context, logical-owner, control-state
and user checks. It reads the same browser without opening another CDP client
or attempting a checkpoint restore. Refusals and malformed/unacknowledged
responses still require worker-carried state for replacement; there is no new
request flag, retry, timeout or provider allocation.

API reference section 8 documents `fresh_allocation=false` as moving to another
address from the pool. Its residential-always-true sentence is contradicted by
controlled c774's actual false response plus changed IP and retained storage;
this does not establish an outage. The original parity test still requires a
changed IP, retained session and storage. The captured response distinguishes
allocation provenance from movement; it does not reconstruct c66/024f bodies.

Permanent regression controls cover true and pooled-false acknowledgements,
missing/malformed proof, wrong/missing session, unacknowledged movement and all
existing ownership/post-read drift checks. The new low-adapter test failed
before repair with TilionUncarriedStateError and passed after repair. The same
17-control response-assembly fixture failed before the assembler repair with
"Logical browser restore requires validated transport" and passed afterward,
with zero CDP connections and zero restores for pooled movement. The registered
blackbox case reproduces that RED/GREEN through the real route/provider stack.
Five consecutive complete provider unit executions passed after extraction.

A fresh unchanged `bash scripts/run-blackbox-tests.sh browser-provider` passed
natively in 225578ms. Its live parity kept the original browser while the exit
changed from 134.215.178.110 to 24.18.178.179, then switched to Kernel mobile
172.56.29.219 with the existing state/ownership assertions intact. This is a
current repaired-source result, not a retrospective pass of either failed
aggregate. The full original coverage invocation and deployment remain pending.
Golden reference: not applicable (no approval-gated hunk). At 10k agents, this
adds no query, socket, retry, allocation or retained state: it changes the
acknowledgement predicate on the already-issued operation.

### Historical investigation before the repair

At this earlier handoff, no source fix or verified fix existed. A private one-shot native probe is ready
for the parent's source-bound worker launch: it reuses the frozen parity setup
on an isolated backend, records raw response/headers plus actual before/after
IP and storage, and verifies exact-session cleanup. It makes one rotation
request, with no body or retry. That will be a new controlled occurrence, not
a reconstruction of original missing bytes. Keep fresh-IP/session/state
assertions. The parent retains source, archive integration and deployment
ownership. This draft and fixture do not modify the checked-in archive.
Golden reference: not applicable (no approval-gated hunk).

Diagnostic f0a5b8c46a94405ba98d00bda3fe0efd exited 1 before provider calls:
the generated module under root .context could not resolve jpeg-js, which is
installed under back-end/node_modules. Original setup/cleanup receipts say
cleanup_complete=true, lingering_group=false; the runner has no native result.
The private generator now places its module under ignored back-end/.context.
The exact source imports were verified in a mirrored package layout with
global fetch denied: exit 0, PROBE_MODULE_LOAD_OK. This is setup proof only.
Corrected probe SHA256 is
2d283290500b92b60f582300cdf7556e78c129005dfe3045d781ccd9f00242fd;
launcher SHA256 is
3847f3bd162d18999d49e28316e4c1032e4c8f9af607a23031ef2aa33e23a009.

The corrected native diagnostic c7743039f17e4d36b77f2d2638a0eb60 completed on
the frozen source. Request 8f7b458507df442a returned HTTP 200 with the full body
recording rotated=true, region=us-east-1 and fresh_allocation=false. This is a
new controlled occurrence, not a recovery of the original response. It retained
the same native session, changed exit IP 67.183.49.85 to 68.224.67.66, and
preserved localStorage=kept. The diagnostic then failed its explicit unchanged
fresh_allocation=true assertion. DELETE returned 204; the retained status is
closed with cleanup=done and absentFromLive=true. Worker process cleanup was
also confirmed. Captured result SHA256:
cc585d0b21b9ee581499797d50566d94b72823f7e77270184cd28d8d522d0eb2.

The captured body was then replayed through the real adapter, replacement and
HTTP mapper from each compared revision. RCA_REVISION=head and
RCA_REVISION=main, each with node --import tsx captured-replay.cjs, both exit 1
with the same 409 versus expected 200. The caller, native freshness condition,
live-session state refusal and 409 mapper have the same implementation on
both revisions. The no-preflight native diagnostic also demonstrates this
condition without the screenshot change. This supports NOT_INTRODUCED at the
observed rejection boundary; it is not a repaired-source PASS. Original raw
field shape and original pre/post IP remain unknown. Worker A independently reviewed native evidence and the source comparison,
approving the limited NOT_INTRODUCED attribution. It did not claim a fixed
RCA, review a source patch or authorize ignoring freshness. The reviewer subsequently read the exact replay fixture, source comparison
and both replay logs and confirmed no remaining attribution objection.

## Human feedback

The user limited this investigator to evidence, private fixtures and a drafted
fix, retained parent source/deployment ownership, prohibited full-gate launches
and required preserving Freedom. No assertion, budget or unknown was waived.

## Reusable lesson

Retain native rotation response fields and same-session exit observations before assigning a freshness failure to provider behavior or changing the acceptance contract.

## Independent repair handoff

After accepting the limited attribution, the parent explicitly assigned this
thread independent repair ownership. Accepted and OPEN at
https://boxes.dev/thread/thr_43792b37faf749c69821eb62a4695992 (HTTP 200 verified).
At that handoff work was limited to private proofs and a drafted exact fix; parent retained
source integration and deployment. No assertion change or provider retry is
authorized by this ownership record. The handoff is separate from the RCA
attribution and does not turn either native failure into a pass.

## Successor recurrence 024f3d37965341c4939da1be5887357a

The fresh successor run on 7be0644bb164763af1526ead7b426e2d5e909f4a
(source digest 8448a1822106d530f7938f3fae5470f9468881d8304949137bb659873e044a3d)
records browser-provider FAIL. All relevant provider, route and parity-test
bytes are unchanged from 067495d51. At server lines 82119-82133, task
3a2181d7-2cdc-5d90-8766-d0d2333e02a9 takes rotationsUsed=1. Native request
4f31d5bfb3484f3e returns 200 in 2331ms, logs rotated=true and
freshAllocation=false, then backend returns 409 carried_state_required.
Domain line 663 is the same first-rotation failure, not a later assertion.
Server SHA256 cdc0e9cae7f712ac92b91cf4110ec3544cddb5498109d01f1d575c819da63aa1;
domain SHA256 16e3409e44f6ba9ddcf355551cc4a2514b33f9bdc71744bc7d71fbbc741c53a7.
The case-aware producer records 243 complete case outcomes, one FAIL, with
coverage thresholds, teardown, units and FPS all PASS and cleanup complete.
These are successor receipts, not retroactive passes for c66. At that successor checkpoint the repair remained OPEN; no freshness assertion was weakened. Source-bound
original request/result and full domain/server logs were read; new native
raw body and pre/post IP are still absent. The c774 native proof and unchanged
local adapter replay support the same limited NOT_INTRODUCED attribution;
Worker A independently reviewed the new logs and source hashes and confirmed
no objection to this limited source attribution. Native FAIL and repair OPEN
remain unchanged.

## Replacement implementation outcome

The high/standard PR1663 owner integrated this evidence and owns the source fix,
original full invocation and deployment. The old xhigh investigation owner
performed read-only review of the complete low-adapter plus assembler patch,
with no blocking objection. Its scope is review, not a competing implementation.
Historical missing raw response/IP evidence remains explicitly unrecovered.
