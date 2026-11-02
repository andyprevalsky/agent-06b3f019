---
id: 2026-10-26-export-verifier-treated-code-as-private-record
date: 2026-10-26
title: Export verification treated readable committed code as a private record
surface: harness
component: cloudbench-resume-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: verify_stage passed the supported mode0644 collector source to the private-record read helper
symptoms:
  - private current-owner file required at verify_stage collector_path
  - cloudbench-export-recovery failed 29 tests with 4 errors
  - clean committed mode0644 source accepted by launcher but rejected by export verification
tags:
  - export-recovery
  - source-verification
  - file-permissions
  - private-record
sources:
  - commit 20ba31ca2470f3a6399375a9f9c1e160dcd8b347
  - commit 70e2cad0c8
  - plan:.context/rca-export-fixture/findings.txt
repro: bash scripts/run-deploy-stage cloudbench-export-recovery -- python3 scripts/tests/cloudbench-resume-controller-export.test.py
status: fixed
---

## Problem

The required export-recovery gate failed four of its29 tests. Each reached
verify_stage and rejected the committed collector file with private current-owner
file required. The actual collector was mode0644, current-owner, single-link.
The rest of the export fixture was correctly private. Original runtime and
local before/after evidence are retained in .context/rca-export-fixture.

## Diagnosis

The native launcher at run-original600-controller.py:2451 takes its existing
checkout as source_root, verifies committed content in source(), and records that
root in prepare() at1108. The recovery check at cloudbench-resume-controller-export.py:903
selects the original collector from this root. Neither source validator requires
private source-file permissions. A clean exact20ba sparse checkout passed both
source() and cloudbench-original600-runner.py:validate_source_members with the
mode0644 collector. Its SHA256 was87b52cfc31b70d582ed274e184c0b7a6b50267639e2019e21a1e8ead251a55ff.

At verify_stage:1113, the code instead uses the generic private-record reader,
which correctly rejects every file with group/other permission bits. This
confuses code integrity with record confidentiality. That call predates the
main integration; blame identifies70e2cad0c8 from October17. Making the fixture
collector0600 causes all four methods to pass but would hide the supported
native0644 case. The coordinating agent rejected that fixture-only workaround.

Archive searches used private current-owner file required collector fixture
permissions and export resume verify_stage collector_path. The normal-controller
borrower-capture case is related, but its missing custody receipt is a different
boundary. No exact prior recurrence was established.

## Solution

The applied production change gives
collector code a bounded reader requiring a physical path, current owner,
single regular link, no group/world writes, size below16MiB and stable FD/path
identity. It retains the original launch hash check, executes exactly the
validated bytes, and rechecks source after namespace setup. The private-record
reader and its no077 rule remain unchanged. Executing validated bytes also
avoids reopening an unverified pathname through runpy.

Opened golden references support the distinction and guards: OpenClaw
package-update-activation-immutable.ts:42 checks code identity with no022,
while package-update-activation-paths.ts:90 keeps no077 for private state.
package-update-integrity-hasher.ts:33 compares complete descriptor metadata
before/after a no-follow read. Claude bundledSkills.ts:170 explicitly creates
its private code staging rather than assuming an existing checkout is private.
Hermes update_cmd_zip.py:121 copies through an exclusive FD and preserves source
modes. Codex login/src/auth/storage.rs:214 creates confidential auth state0600.
Rose's collector at cloudbench-controller-export.py:221 already executes
hash-validated source bytes with an explicit original __file__.

The initial native stage command ran in the exact source checkout: original29
tests failed with four errors, and the same29 passed with the source-bound reader.
Independent adversarial review then caught a remaining executable reopen:
file_sha used runpy.run_path on the mutable collector for every payload hash.
With source_root equal to the operator checkout, a real replacement immediately
after the second checked source read executed untrusted code and verification
still succeeded. The initial61d27a8c candidate was rejected and never applied.

The accepted V3 implementation hashes payloads directly in1MiB chunks, preserving the old
sealed_bytes(path, limit=None) physical-path, regular-file, single-link,
O_NOFOLLOW/O_NONBLOCK and complete descriptor/path identity checks. It does not
change data-size limits or private-record policy. The source's expected hash and
captured bytes bind execution; metadata equality alone is not a proof that every
same-timestamp write was absent.

A permanent late-swap control uses the actual collector and existing native
ExportResume payloads, makes HERE/source_root/collector_path share one scratch
tree, replaces the collector after its second checked read, and requires that
no replacement marker executes. A second control preserves direct data-hash
symlink/hardlink/inode-swap refusal. The same registered native command and
identical33test bytes failed only the late-swap assertion against61d in4.435s,
then passed33/33 in3.479s against revised runtime7f872807. Full exact hashes and
command are in .context/rca-export-fixture/review-snapshot-v3.json; before/after
logs are late-swap-before.log and late-swap-after.log. All original tests remain
unchanged apart from suite-owned TMPDIR setup. The no-extra-staging equality and
no-signal assertions remain intact; no fake pidfd or create=True mocks are used.

Parent registered cloudbench-export-recovery in run-deploy-structural-gates.py
through a portable bash wrapper. On Linux it selects an interpreter with actual
pidfd support; otherwise it dispatches the unchanged suite through the existing
offline Linux controller image. The pinned host3.11 build lacks those APIs.
The offline snapshot has no Git metadata and retains the host file owner, so the
wrapper materializes a current-owner fixture checkout from only scripts/,
agents/benchmarks/, and agents/providers/rose/pools.py, preserving readable
source modes and excluding unrelated env/private input. Native33, dispatcher
ownership18, and cached offline33 checks passed. The exact container was retired
and its absence verified. Receipts are in .context/rca-export-portable-gate/result.json.
This dispatch proof does not satisfy live Mac acceptance.
The isolated TMPDIR wrapper prevents unrelated workers' files from entering the
suite's no-extra-staging inventory; external-file creation was reproduced red
with the old footer and green with isolation. It does not hide files created by
the code under test. No controller or provider operation was performed.

Independent V3 review returned GROUNDED with no blocking finding, recorded in
.context/rca-export-independent-review-v3/review.txt. The coordinating parent
then applied the exact accepted runtime and test bytes after checking original
source hashes. The shared helper SHA256 is
7f872807451b2fe302f6687341d7b72b02ae5bc96ac0bc197591c85069ff2e8a;
the shared owning test SHA256 is
f43c2fff71b15bdc89db9c3d67143331dc84dca2fc300e39d4c365fa42229e88.
Both hashes were independently read back after application.

The parent ran the native shared-workspace export-recovery stage after applying
those bytes. Its retained .context/rca-6731984c/export-v3-applied-native.log
reports33tests in3.682s, OK, stage exit0, with canonical stage log
.context/deploy-runs/20261026-1921-planner-main-integration/logs/cloudbench-export-recovery-20261026-200516-2423990.log.
The local export verification defect and registered owning regression are fixed.
The parent still owns the combined67-gate run, direct Linux gates, deployment
acceptance and archive indexing. No full original controller workload,
provider export, deployment or unrelated sealed-gate repair is claimed here.

## Human feedback

The coordinating agent required native evidence and unsafe-input controls, authorized a
private-copy diagnostic, prohibited changing repository permissions or weakening
private reads, and required exact diff review before shared edits. The coordinating agent
confirmed no native private-source-root proof exists and rejected a fixture-only
fix. They authorized this case record without INDEX changes and require an
independent snapshot verdict before production edits. The independent reviewer
proved the late executable reopen, requiring its removal and a permanent
same-path late-swap control. Parent rejected fake pidfd test support and selected
a native interpreter with the actual APIs instead. No parent DB, provider,
controller, credential or Freedom work was performed by this investigator.

## Reusable lesson

Validate committed code for integrity at its source boundary while retaining confidentiality guards for private records.
