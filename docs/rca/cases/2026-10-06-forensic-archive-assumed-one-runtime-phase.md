---
id: 2026-10-06-forensic-archive-assumed-one-runtime-phase
date: 2026-10-06
title: Generic failed-owner archive required every allocation to have one runtime shape
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generic verify counted every historical allocated Machine as a primary or legacy worker and required service files for every task
symptoms:
  - KeyError original-native-config.json in verify_pre_service_archive after archive builder rc0
  - AssertionError at len(by_machine) == len(rows) + len(unstarted_workers) + len(started_workers)
  - complete original pre-service capture lacks mandatory service files
  - original backend log grew after the exact stopped-provider cleanup receipt
tags:
  - cloudbench
  - exact-owner-recovery
  - forensic-archive
sources:
  - PR #1299 follow-up
  - fleet run 20261007-001156-61479
  - commit 61148634e2dcad07bc951227e91ecf9e69eb47ce
  - fleet run 20261027-191440-2597567 owner 49927b5b138945249cb5e040f87159c8
repro: scripts/tests/cloudbench-forensic-quiesced.test.py
status: mitigated
---

## Problem

The failed DAILY50 owner retained 50 task primaries, six verified unallocated
attempts and three normally retired worker attempts. Its complete original
capture contained 48 sealed guests, one guest that stopped before service
startup, and one failed-service guest with native stopped/provider cleanup
proof. The generic verifier required all allocated IDs to appear as primary
or legacy worker rows and required five service files from every task. Neither
condition described the preserved execution phases. This recovery carries zero
benchmark credit, and native release remains a separate obligation.

## Diagnosis

Archive searches used `forensic service stopped mandatory manifest` and
`failed owner pre-service allocation destroyed provider retained`. The source
recipe and forensic ordering cases are relatives: they protect different
boundaries and do not establish this mixed allocation/runtime contract.

The unchanged compact owning assertions on 93dea65 failed at the generic
allocated-Machine count and stopped-provider backend hash equality. Read-only
replay of the complete original archive, owner and all 59 audit records failed
at the same count. Only canonical evidence-file reads were
redirected to private staging; the original registry and run were untouched.

The failed-service guest's later backend capture is an exact extension of the
previous cleanup log. Existing parsers identify the same root, provider session
set and allocation/mutation counters; the suffix has zero root creation, browser
allocation/mutation and payment mutation. The original stopped proof and provider
receipt independently validate against their unchanged original log. Exact hash
equality incorrectly rejected this complete later evidence. Original failed
cleanup states remain preserved; no intermediate cleanup reason is inferred.

## Solution

Generic archive verification reuses normal worker capture verification for the
fresh child subset, retaining honest exit status and startup state. Worker rows
must archive every file required by the unchanged normal capture manifest, and
retired dispositions still require native absence. All allocated IDs remain in
the existing final native absence checks.

Pre-service rows carry the original ACK, exited driver, explicit service/run/log
absence and unchanged original-volume/config/capture bytes. Native executable
and provenance binding reuse the existing source validator and reviewed
before-stack-launch source policy. Native recipe verification is shared with
bootstrap verification; captured checkout verification remains mandatory for
bootstrap callers. No checkout evidence is synthesized.

Failed-service rows reuse exact stopped/provider receipt verification. A later
backend log can reuse the earlier receipt only through exact prefix identity,
unchanged parsed ownership and a suffix containing no new allocation or payment
mutation. Archive readiness continues to report `native_release_verified=false`
and zero credit. Default final absence checks and ordinary native reaping remain
unchanged.

The same full original archive passed with 50 rows, three normal
worker captures, six unallocated attempts and 628 preserved members. Thirteen
compact owning controls, 25 original bootstrap controls and 26 existing generic
forensic controls pass. The owning script is already registered in `scripts/test.sh`,
`run-deploy-structural-gates.py` and the ordinary deploy command. This is bounded
work over one failed owner's archive, outside the agent execution hot path;
10,000 live agents introduce no shared per-agent lock or polling channel.

Independent review cleared the frozen runtime/test candidate at
`61148634e2dcad07bc951227e91ecf9e69eb47ce`, independently passing all nine new
owning controls and replaying the unchanged original archive RED/GREEN. The
candidate's default final verification still rejected the original active
native inventory. Exact native recovery and deployment qualification remain
required before claiming the original resources released or deployed. Status
remains mitigated while that native obligation is outstanding; no new benchmark
execution was performed.

### October 27, 2026 recurrence: producer omitted the pre-service proof envelope

Archive searches used `KeyError original-native-config.json` and
`original volume archive recovery wrappers`. This is a recurrence of this
case's producer/consumer contract: the phase-aware consumer was cemented with
hand-built complete archives, while the generic original-volume builder never
carried the native collector's config/provenance sidecars. Capture succeeded,
but the first bad boundary was capture artifacts to generic archive members.

The unchanged historical 2,704-byte packet (SHA-256
071a10dba7b84f579836e89ae3d02179435f20c7c362bdd554abfbbc1f77a996)
was replayed locally through real `verify(archive_only=True)`: it raised
`KeyError: 'original-native-config.json'`. The new registered
`PreServiceArchiveTest.test_native_capture_builder_roundtrip_uses_real_verifier`
ran against parent 05125f70e and failed at the same boundary in 3.152 seconds.
The fixture runs the actual CLI builder and full verifier, with the existing
fixture-only reviewed-source policy; historical replay uses the real policy.

The reviewed adapter preserves the original config, raw nested capture and
native provenance bytes. It consumes the collector's own typed receipt rather
than inventing legacy `capture_complete` or `restored_original_config` fields.
The collector's config digest is canonical JSON; its saved private JSON has a
trailing newline. Legacy receipt validation and source policy stay mandatory.
The regression checks exact archived wrapper bytes, zero credit and no native
release; adversarial checks rehash the outer packet before testing inner
identity, config, capture, absence and native-stop authenticity.

Opened artifact-custody references: OpenClaw
`src/commands/backup-verify-manifest.ts:100-206` retains typed source/payload/config
inventories, `src/infra/backup-create-stream.ts:11-31` seals actual traversed bytes,
and Hermes `scripts/ci/archive_inputs.py:106-145` verifies archived size/digest.
These support preserving and validating complete original evidence; they grant
no Fly authority. No live-agent hot path, per-agent lock or polling is added.

Independent reviewer `ph7cqance5nyhhhfe7rtfkwd9s8h3wf5` returned `GROUNDED`
for approval `polar-k2-i10-native-capture-v1` on base 05125f70e, runtime patch
SHA-256 d89aeee8d0a10711596729f0115e211078d7d1fa1c2fce142f42782e8467fcc0
and test patch a640b3c2775a1107373e5b7c48ae44c0aa5b08b0540502fa061275466753d908.
Review opened every cited reference plus Codex source-ledger content identity
and searched Claude/Kimi for contrary practice. The reviewer independently
reproduced RED in 2.406 seconds, roundtrip GREEN in 2.707 seconds and all 19
owning tests in 56.507 seconds. Only then were the exact reviewed runtime bytes
applied. The unchanged author roundtrip passed in 3.574 seconds.

Author gates on the exact reviewed bytes: owning forensic suite 19/19
(66.438 seconds), prestack recovery 14/14 (1.376 seconds), prelaunch cancellation
6/6 (3.098 seconds), all four new tests five consecutive runs unchanged, gate
registration test, archive validation (1,177 cases), and diff whitespace check.
The owning suite remains registered in both the general test runner and the
deploy structural registry; no new skip or exclusion was introduced.

Launch owner `ph7bpz2f14pct3j92t0e6nrvmx8h3nep` then replayed the exact
private config/capture on committed 180fe6d260754dbae78336cde543e4d5b43df3e5
with Fly API token unset. Builder and real full `verify(archive_only=True)`
returned rc0: 196,422 bytes, nine files, one interrupted task, zero credit and
`native_release_verified=false`. Archive SHA-256:
cde579e3adf915a463f4c62626b8054b3c8e777de76fd8e658a6491fd5b5bba2;
manifest SHA-256:
f225a107973b611485207ee92ab324f3f0c1022d7f0c50e4aa275539d1f7e402.
Capture inputs and the original rejected packet retained their before-run
hashes. The owner reported two earlier scratch-environment refusals (missing
historical Git objects, then uncommitted extracted source); only the committed
source run is GREEN evidence. The new archive contains private config and stays
local. This proves the archive contract, not native release or task outcome.

No canonical recovery, new capture, provider mutation, paid benchmark or
deployment is authorized in this lane. The historical native config stays
private on the launch owner's box; its complete environment is never committed
or sent as a shared fixture. The case stays mitigated pending native release.

### Supported rebuild of an already rejected canonical packet

The parent identified a second producer boundary: an existing rejected
`_forensic` makes the default builder refuse at exclusive directory creation.
Manually renaming or deleting that evidence is not an authorized recovery
procedure. The unchanged real CLI regression
`PreServiceArchiveTest.test_hash_bound_rebuild_preserves_previous_packet_and_real_verifier`
failed on 180fe6d26 with rc2 / unrecognized rebuild arguments in 2.756 seconds.

The supported CLI is the same builder with `--rebuild-existing`,
`--expected-manifest-sha256 <rejected-manifest-digest>` and
`--expected-archive-sha256 <rejected-archive-digest>`, plus the existing exact
`--registry` and `--capture-dir` arguments. Both hashes are required. This is a
separate offline operation before canonical recovery; it refuses its shared
recovery lock while another exact-owner operation is active. It validates the
old private two-file packet, owner/run/schema/zero-credit envelope and both
hashes, builds a new packet in private sibling staging, and rechecks old custody,
staged directory identity and expected payload hashes, parent identity and
ownership latches before exclusive publication. The original directory is
preserved at `_forensic.rejected-<manifest-digest>`. Default building still
refuses an existing canonical packet. No evidence latch is cleared.

Interrupted final publication restores the original only into an absent name;
a concurrent entry is never overwritten. Process death after preservation can
leave canonical absent with both old packet and stage retained. Repeating the
same hash-selected CLI restores that preserved original under the existing
lock and rebuilds, retaining partial staging for diagnosis. Native release and
the full consumer remain independent gates.

Independent review rejected initial runtime proposal 727fb4fc after actually
substituting its completed staging directory and observing false builder
success. Those runtime bytes were never applied. Revised approval
`polar-k2-i10-rebuild-v1`, runtime patch
bfa4117a759c3e2a7caac57308d70fe6c6520f9972e91aaed831a32803515498 and tests
21d1be0d70b7f1fdded9655bb603b4f4db4e89d2c8c34fb89877697a9bb00339,
was `GROUNDED` by the same independent I5 reviewer before application.
The revised candidate refused the unchanged substitution reproduction. All six
rebuild tests independently passed in 16.056 seconds; reviewer baseline RED was
2.454 seconds. Added opened reference
`openclaw/src/infra/backup-archive-publication.ts:75-120,185-230` binds private
same-parent staging/source identity and exclusive durable publication.

Author unchanged rebuild CLI repro passed in 3.046 seconds. Regressions include
held lock, old packet and staging payload/directory substitution, parent alias,
wrong digests, failed capture, existing preserve destination, unexpected files,
final-rename failure with rollback and concurrent destination, and an actual
killed test child followed by successful same-CLI resume. Final author gates:
25/25 owning forensic tests (81.636 seconds), 14/14 prestack recovery
(1.449 seconds), 6/6 prelaunch cancellation (3.040 seconds), all six new rebuild
tests five consecutive unchanged runs, archive validation and diff check.
The same registered suite runs both producer-format and rebuild regressions.
Owner-local private historical rebuild proof remains a separate pending gate;
no canonical packet or resource was changed by the author.

## Human feedback

Preserve meaningful lifecycle stage endpoints, avoid aggressive inner criteria
or timers, permit genuine task FAILURE, preserve complete truthful originals,
and require exact terminal resource release. Do not fabricate receipts or grant
acceptance credit to recovered or interrupted executions.

## Reusable lesson

Validate each allocation and runtime phase through its existing terminal owner contract while preserving every original byte and the independent final native release audit.


## November 11, 2026: original-volume capture rejected verified append history

This is a recurrence of the immutable-log assumption at an earlier admission
boundary, `cloudbench-original-volume-capture.py::cross_check_receipts`. The
October archive verifier's prefix rule did not cover this separate capture
reader. Archive searches were `capture contradicts the recovery observation
backend.log` and `stopped capture append-only log grew after live stat recovery
manifest prefix`. The forensic phase case is related evidence, not a substitute
for replaying this incident. The repair is integrated into the existing owning capture reader.

The supported original-volume capture for Machine `812446f9e74318`, volume
`vol_vwn5j8g236m7dx8v`, owner `6907dca0cb904bb1b60dec05fdec9bec` actually failed
with `capture contradicts the recovery observation of
repo/.context/cloudbench/logs/backend.log`. Its preserved failure and journal
report restoration and stop; this worker did not query or mutate the provider.
The task's original verdict and cleanup obligations remain independent.

The old state observed 2,749,109 backend bytes. The earlier regular copied log
contains 2,750,324 bytes and SHA256
`8a7c298590f28d0e07db98e2a5fc6cabb35b717c94c86e58969465e86a875252`, exactly
matching the original provider manifest. The retained stopped capture contains
2,761,838 backend bytes and SHA256
`30101fbd09e24be9c4508bd1f634626ae7bf8b2bcce88a981703e67d30deaca0`.
Its first 2,750,324 bytes equal the entire earlier hash-bound copy. The size
inequality is therefore not a contradiction: the observation, copy and final
capture represent three different collection instants. Equality at both old
checks made this authentic history impossible to admit.

The isolated candidate changes only receipt-integrity classification. A backend
size mismatch is accepted only when both receipts match the exact Machine and
run token, the old observation explicitly reports a regular nonlinked log
within its limit, its size is a nonnegative integer, a safely read complete
nonempty earlier regular copy matches the native manifest SHA256, and
`stat_size <= copied_size <= captured_size` with genuine growth beyond the
stat and exact complete-prefix identity. The earlier copy's verified digest is
included in `receipt_cross_checks`. Foreign receipts refuse explicitly. The
original capture inventory/member checks, unsafe-path checks, existing JSON
presence/size and recorded hash comparisons, native stop/config/volume proof, zero credit and release
checks remain independent. The file reader checks regularity before `fdopen`,
so a directory refusal also closes the descriptor; no size limit is increased.
No receipt or original byte is rewritten.

The exact real `cross_check_receipts` call against the retained original tar,
state, manifest and copied log exits 1 with the recorded error before the fix
and exits 0 with the isolated candidate. The same eleven new owning test methods
in the existing registered `scripts/tests/cloudbench-bootstrap-recovery.test.py`
run through its native unittest/sharding entrypoint: unchanged code has three
append-case errors and eight passes; the candidate passes all eleven. Adversarial
controls preserve refusal of changed prefixes, truncation, inconsistent sizes,
foreign Machine/token receipts, missing or wrong native hashes, absent receipts
or copied evidence, unsafe/nonregular copies and JSON presence/size contradictions or changed recorded run-JSON hashes. An exact
unchanged log still uses the original exact-match path without needing a prior
copy. Native-sized evidence exercises the existing 512 MiB cap rather than the
1 MiB JSON default.

Independent review approved the narrow delta and the integrated registered tests passed 11/11. A fresh supported inert capture then completed with the exact original configuration restored and the Machine stopped. The verified archive SHA256 is `033c2ea63a996c1d2c8ba73896f9bef5c61f65717a14b66193d6ff7cbeb13224`. The normal interrupted archive builder and exact-owner recovery subsequently completed; the native audit records provider teardown verified. The original failed capture, incomplete benchmark receipt and missing original run JSON remain preserved. Capture and archive evidence grant zero benchmark, financial or provider-session cleanup credit; physical retirement is a separate native receipt.

The generalizable problem is a logical inconsistency between mutable collection
observations and immutable receipt verification. Deleting size/hash validation
would lose evidence; this candidate unifies acceptance of the one mutable
backend-log history around the existing native hash and entire earlier bytes.
It does not generalize append acceptance to JSON, other files or other owners.
Work is bounded to one owner and existing capture size cap, outside the live
agent hot path; it adds no per-agent channel, polling loop or shared lock at
10,000 agents. Golden reference: not applicable (no approval-gated hunk).

Human instruction for this recurrence: do not assume resizing is safe; preserve
all permissions and guards; accept only cryptographically verified complete
append history; keep foreign/missing-hash/truncated/changed-prefix/JSON evidence
fail closed. The coordinator owns integration and actual capture/cleanup.

Precision limit: services.json has only presence/size in these historical
receipts, with no prior content hash. A same-length services.json mutation is
therefore not observable by this preexisting guard and remains accepted on both
sides; this patch does not newly permit it, and claims no arbitrary JSON
immutability. A recorded run_json_sha256 still rejects same-length run JSON
changes. No prior JSON receipt hash or original bytes are invented to fill this
historical evidence gap.
