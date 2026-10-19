---
id: 2026-10-04-hub-transport-duplicated-diagnostic-logs
date: 2026-10-04
title: Final Hub transport duplicated diagnostic logs beyond the decoded body limit
surface: harness
component: benchmark-hub-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Hub uploader included duplicated process logs in its terminal HTTP body
symptoms:
  - Fifty evaluated task rows remained live after final upload returned HTTP 413
  - Gzip transport fit upstream size limits but failed the decoded Express limit
tags:
  - benchmark-hub
  - publication
  - payload-size
sources:
  - PR #1410
  - fleet run 20261004-201108-11163
  - PR #1453
  - agent bb938dbe-1cc2-437c-80e7-faf31f300ce2
repro: scripts/tests/benchmark-live-results.test.py
status: mitigated
---

## Problem

The real fifty-task parent prepared a 305,285,322-byte decoded request. Gzip
reduced its wire size, but Express still enforced its existing 100 MiB decoded
limit. Finalization returned HTTP 413, leaving the dashboard live.

## Diagnosis

Archive searches covered Hub 413, gzip, decoded limits and parent publication;
the October 2 plain-JSON case concerns the earlier wire boundary. An unchanged
actual-parent fixture sent through the real Express parser was RED (HTTP 413).
Worker diagnostic logs dominated the payload; Hub agent/index consumers require
messages/tree and task metadata. Independent review checked those consumers and
preservation. The same fixture became GREEN (HTTP 201, 2.125 seconds); original
full-child and metadata controls were unchanged. Diagnostic owners retired.

## Solution

Copy the transport projection and omit only worker_logs, backend_logs and
realtime_logs. Keep every complete message/tree, task metric and evidence
reference. The actual decoded body is now 22,557,739 bytes; all fifty transcript
pairs and original local bytes are unchanged. Forensic diagnostics remain in
local full bundles and their archive. Keep the parent live until actual release,
then publish final transcripts and stop frontend polling.

The compact deploy control exercises the same decoded boundary, full fan-out
transcript preservation and nonmutation. Backend round-trip and frontend phase
coverage own the rendering boundary. Production follow-up remains pending;
loopback proof grants no benchmark acceptance credit.

## Human feedback

The user requested accurate frontend state updates and rapid pass/fail visibility
before teardown, with compact tests cemented in deployment.

## Reusable lesson

A compressed body can still exceed a decoded parser limit. Keep duplicated
forensic blobs out of the view transport without truncating evidence or raising
the memory boundary.


## 2026-10-17 recurrence: owned-root logs bypassed the existing transport projection

### Actual outcome and first bad boundary

Original30 group `35c109a9-92a5-4e30-bbcf-0aefacfe277a` ran immutable native
source `0a74e8d555c9f793360c5ca2c78f5950939ecc0a`. The genuine result is
23 PASS / 7 FAIL; controller exited1 at 03:05:06.5609UTC after all32 exact
provider cleanup acknowledgments. Terminal Hub upload returned HTTP413. The local
serializer had already written the complete 260,722,360-byte export, SHA256
`394b6d1438499f8f8e6810b59efb27b73e891447dc1ed81a4e74bde2099b9dd7`.
`BenchmarkRun.save` calls its uploader before returning; the CLI prints
`Results saved` only after that return. Therefore no genuine marker was emitted.
Do not invent a marker, successful save return, upload success or all-pass grade.

The new per-task custody representation retains `owned_roots[*].logs` for every
fixture/graded root. Those records accounted for126,239,683 serialized bytes;
projected task.logs accounted for4,743,816. The October4 projection removed only
top-level task.logs worker_logs/backend_logs/realtime_logs. It did not visit newly
retained owned-stage logs. The fit helper found no top-level worker logs left and
returned an oversized body, logging zero lines omitted. An initial speculation
that complete messages/tree dominated was withdrawn after field measurement:
they totaled only about4.55MB at the top-level log owner.

This is a recurrence of the same diagnostic/view transport inconsistency at a
new nested owner, not a reason to remove root custody or truncate transcripts.
Canonical gzip compression does not avoid the decoded Express limit. Retained
HTTP metadata proves413; it alone does not prove the remote deployed parser
revision. The separate realtime SDK empty-rejoin shutdown traceback is not the
blocking `HubVisibilityError` and remains outside this repair.

### General correction and owning proof

The private registered candidate patch
`6e28c51d5829b307d6bd11d9f6f47ed3e56de9ae5448b07c159efbe8b79def33`
extracts ONE existing log-owner projection and uses it for task.logs and every
owned-root log record. It copies dictionaries and omits the same three diagnostic
blobs only. Complete messages/tree, stage outcomes, creation/role identity,
archive/seal/provider/payment receipts, task metrics and native grades remain.
The full local export is unchanged. No body limit, timeout, gzip policy, task,
evaluator, deadline or call limit changed. No new ownership/registration grant or
synthetic TaskResult is introduced.

- The permanent synthetic test in `agents/benchmarks/hub_upload_test.py` fails
  baseline on nested diagnostics and passes the candidate with all non-diagnostic
  evidence and input equality checks. The existing benchmark.blackbox domain now
  calls that test through its normal wrapper and `r.record` registration. The
  actual wrapper/registration executed through real BlackboxResult:1 PASS,
  zero network attempts. Existing2525 benchmark and105 Hub assertions remain;
  Hub final count112. The existing normal pytest selector `hub_transport` also
  discovers the new test; this is not an unregistered standalone-only check.
- Actual private export through the same real projection assertion: baselineFAIL
  decoded131,054,908/gzip7,407,214 bytes; candidatePASS decoded10,058,584/
  gzip1,524,430. Every non-diagnostic transcript/custody/grade field and original
  export hash remains equal. This is source-derived reconstruction, not captured
  historical HTTP wire equality; environment group augmentation was excluded.
- The actual Express JSON parser on a fixture-owned127.0.0.1 ephemeral server,
  with unchanged100MiB decoded limit and gzip inflation, returned baseline413
  (`entity.too.large`) and candidate201 with tasks30/passed23/failed7. The
  server closed normally. No actual Hub/prod/provider upload was used for proof.
- Full Hub owner:36 pytest PASS in8.98s. The guard wrapper exited99 because ONE
  existing intentional127.0.0.1:1 negative was denied;19 exact test-owned loopback
  connections were allowed. This is not an unqualified launcher exit0 or zero
  attempted network. Parent-process external/shared traffic was denied; child
  fixtures retain their source-owned fake/loopback contracts, not a claimed
  universal cross-process interception. Earlier missing private source/import
  failures are preserved; required source copies/read-links fixed invocation,
  without deleting or weakening assertions. All owned test processes joined.
- Independent source review scoped-accepted the shared projection. No full native
  repair or universal class-elimination result follows from these local tests.

Private proof root:
`/home/boxes/rose/.context/auth-deploy/repair-native-original30-0a74e8d-20261017/hub-413-review/`.
It retains candidate-registered.patch/registered-proof.json, owner-before.log,
owner-guarded-final.log, registered-owner.log, actual-pair-result.json,
express-result.json, source hashes and original failed attempts. Commands/scripts
are retained there; exact donor venv interpreter was
`/home/boxes/rose-auth-final-deploy/agents/venv/bin/python` with no installs or
active-source edits.

### Resource, serializer and publication contracts remain separate

The parent-reviewed local-artifact fallback binds the exact serializer output,
source/group/run/log/hash provenance as `local_serializer_after_upload_failure`.
It retains marker_present=false, publication_status=failed_http_413 and the
honest unknown actual inner invocation start (`outer_launch_lower_bound`). It
must not treat a local JSON file or cleanup acknowledgment as upload success.

Actual diagnostic resource proof
`diagnostic-resource-proof.json`, SHA256
`4803ddb71a14ba568ec3512166cd63390d1664671a4625f133fe6e124de750f0`,
verified03:16:39.371723UTC: known_roots32/resources_reconciled=true,
controller_exit1/normal_benchmark_ack=clean/native23/7. It explicitly keeps
publication_admitted, deployment_admitted and admission_enabled false. This
proof is resource evidence, not publication or task acceptance.

The explicit publication-only shim pins the canonical0a publisher, package,
corrected hub_upload module and sibling logs.py, preloads only the reviewed
transport module, then uses the original publisher/CLI. Native0a did NOT execute
that corrected module. Its fake-opener actual canonical `upload_run_json` proof
retains30 rows/23/7 and canonical FE URL shape with no real HTTP. Real publication
requires the separate parent binding/release/once/child-join guards and explicit
`publication_transport_override` metadata. At this draft's checkpoint the parent
reported16+ of30 fresh canonical publications; the batch was still active. This
append does not certify final30/30, rewrite the initial413, or claim unpublished
rows succeeded. Parent must retain the eventual actual result separately.

### Remaining scope and human instruction

The existing fit helper can still return an oversized non-diagnostic payload
when no worker logs are trimmable. That independent preflight limitation remains
OPEN; do not claim arbitrary huge transcripts fit or add arbitrary drops/cap
increases. The native23/7 outcome remains unchanged. Broader consumer consistency
is coherent, but no fabricated Step5b failed-coherence or all-class repair is claimed.

Re-read this case's Solution/Human feedback and process feedback. Actual archive
searches used `Hub upload 413 Payload Too Large decoded` and
`duplicated diagnostic logs owned roots transport projection`; both led here.
The earlier gzip/wire failures remain distinct relatives. Append to this existing
case, preserve its mitigated frontmatter and prior proof; create no duplicate ID.

The user's standing instruction is: "dont ask me to aprove prompt changes unless
they prove it passes, u only need approval at the deploy step". This authorizes
continued private proof before a deploy approval request; it is not deployment
approval, a failed-gate waiver, or permission to interfere with Freedom. No new
approval request is implied by this diagnostic publication correction.

## October 14 recurrence: inline native retirement

Run17's terminal publication returned HTTP 413 after the existing diagnostic
projection. Its complete original was 305,185,833 bytes; the compact prepared
HTTP body was 107,214,710 bytes, exceeding the uploader's 94,371,840-byte
budget. The remaining duplicated `logs.wmh_retirement` was 100,609,899 compact
bytes. The original worker/backend/realtime projection was already active and
could not remove this newly included diagnostic class.

Actual frontend consumers render messages/tree; the evidence publisher validates
browser cleanup/recordings and transcripts. Neither requires the native
retirement diagnostic inline. An earlier proposed hydration requirement was
unsupported and withdrawn after tracing those consumers.

The optional `--forensic-archive-receipt` publisher path now downloads the existing
encrypted forensic archive and authenticates/decrypts every frame, verifies all
member SHA256s and the embedded manifest, and exhausts the ciphertext/compressed
stream hashes. Canonical run and native root/session/content bindings come from
those recovered originals. Only then does the transport projection replace the
duplicated retirement with private object identity and digest references.
Ordinary publication without this explicit option retains its previous path.
Original local bytes, full archive, task verdict, messages/tree, and browser
verification requirements are preserved.

The same owning projection assertions recorded 107,214,710 bytes before and
6,605,816 bytes afterward. Registered owning tests passed 46 cases; independent
negative controls rejected unrelated-member tampering, duplicate manifest paths,
trailing ciphertext and receipt-flag bypass. Browser-validation and composite
publisher checks passed. The actual publisher authenticated all 1,160 archived
members, uploaded successfully, exited zero at 2026-10-14T18:28:13Z, and verified
175 messages in a fresh browser. The original fundraiser task remains FAILED
with duration 3,780.2 seconds; publication repair is not fundraising success.

Human feedback for this recurrence: infrastructure changes are automatically
approved; WHM context and logic acquiring runtime context require approval.
This change affects evidence transport only. No new paid benchmark/model run,
merge, deployment, WHM prompt/context change, or production setting change was
performed. Native/canonical JSON parsing can require substantial memory; this
run's publisher completed, but its peak memory was not measured.

Owning regressions: `agents/benchmarks/archived_diagnostics_test.py` and
`agents/benchmarks/hub_upload_test.py`, with the projection callback registered
in `agents/tests/blackbox/benchmark.blackbox.py`. Private proof/body/receipt
artifacts remain encrypted; nonsensitive terminal preservation receipts are in
`docs/handoffs/whm-b07d9037-preservation/run17-infra-verification60m.json`.
