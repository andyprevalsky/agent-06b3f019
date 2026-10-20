---
id: 2026-10-15-controller-export-rejected-retained-retirement-fifos
date: 2026-10-15
title: Controller export rejected retained native-retirement FIFO metadata
surface: infra
component: cloudbench-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The original collector rejected FIFO entries that the native-retirement producer intentionally retains when its permit cohort cannot close
symptoms:
  - unsupported original file type; retain host
  - original controller export stopped at collector line 209
  - .native-retirement.pipe prevented the original evidence seal
tags:
  - cloudbench
  - controller-export
  - fifo
  - evidence-retention
  - source-provenance
sources:
  - commit b85b638584d703726e7581c0c1b7e6fca32632cc
  - fleet run campaign-qualified600-a51c957ecbf73524678e7608-892
  - plan:.context/i42-controller-export-fifo/component-review.safe.json
  - plan:.context/stress600-root/i42-fifo-original-capture-root-review/review.safe.json
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py ControllerExportContinuationTests.test_original_run_fifo_capture_is_metadata_only_and_truthful_tool
status: fixed
---

## Problem

The stopped campaign's original controller still had its original source,
workspace ownership and live init identity. After normal owned-service shutdown
and reversible quiescence of that init's terminal idle loop, the original
collector refused export with `unsupported original file type; retain host`.
It published no verified archive. The init was resumed in the operator's
`finally` path; no FIFO, Machine or volume was deleted to bypass the failure.

A source-bound metadata-only traversal inspected 31,749 selected entries and
found exactly two unsupported entries. Both were single-link FIFO
inodes named `.native-retirement.pipe` under original fleet run directories,
with zero reported file size. There were no selected sockets or device nodes.
The original metadata receipt SHA is
`eaa56d6fe556fe01e415cb788cb3f1f0379b9f6586605b1e7a4c344e781ecaca`.

## Diagnosis

Critical path: fleet native-retirement permit queue creates a FIFO and opens
FD 42 → cancellation or incomplete permit return can retain that FIFO → the
controller collector recursively enumerates the original context directory →
its regular-file/directory/symlink switch rejects the FIFO → the required
original evidence seal cannot be published.

The exact source was commit `82b849eee20f9527426beb4f540d02553d83dc80`, whose
collector SHA is
`a6f37e90716d702a2a1587587fc400ae0bc2e0d477e2d57e6ebb881c3c5afb12`.
Its line 209 is the unsupported-type refusal. An earlier post-export drift
attribution was withdrawn: that attribution had mapped the old traceback to a
different, materialized collector. The old post-export stability predicate is
line 211. The preserved error does not prove a writer or file-state race.

`fleet_native_reap_open` creates the named pipe. Its normal close requires all
unique permits to return before closing FD 42 and unlinking the name. A lost
permit deliberately retains ownership state. Whether close ran, was interrupted,
or failed because permits were missing remains unknown for each historical run.
Archive preparation must not manufacture successful producer cleanup.

The owned defect is the mismatch between the producer's legitimate retained
state and the collector's supported artifact types. Removing the FIFO would
discard original state; reading it as an ordinary file could block on IPC.
Deleting retention guards or weakening quiescence would not repair that
contract. The general solution is lossless FIFO metadata capture with explicit
capture-tool provenance, while preserving the original launch record.

Reference inspection covered all four available harnesses. Claude Code
`src/utils/fsOperations.ts:149` classifies special files before path handling;
OpenClaw `scripts/release-telegram-candidate-archive.py:285` rejects special
archive entries; Hermes `tests/hermes_cli/test_profile_export_special_files.py:41`
requires optional profile exports to skip sockets and FIFOs; Codex
`sdk/python/tests/test_artifact_workflow_and_binaries.py:928` rejects FIFOs in
runtime packages. Their common boundary is explicit type handling rather than
ordinary content reads. Rose's mandatory original-evidence contract requires
preserving FIFO metadata, so profile omission and package rejection do not
satisfy this capture operation.

Archive searches used `unsupported original file type controller archive FIFO`
and `quiescent controller evidence export named pipe metadata snapshot`.
The detached-helper pipe case and optional offline diagnostic-export case are
relatives, not recurrences: this failure is neither an inherited descriptor
holding EOF nor optional test-container forensics. It occurs in the required
original controller custody path.

## Solution

The existing tar exporter records FIFOs as `FIFOTYPE`, size zero, with source
mode, UID/GID, device/inode, link count and nanosecond modification time bound
into the manifest and PAX metadata. It never opens the FIFO. The verifier checks
the exact member type and metadata. Socket and device refusal, writer scans,
driver/source/root checks and pre/post file stability remain enforced.

An explicit capture-tool ref binds the new executable to its exact Git blob
while the original controller remains on its original source. The manifest
separately records the new capture tool and the immutable original run,
collector and launch hashes. Verification checks the archived original launch
bytes and JSON. Continued launches use that declared, source-bound capture
tool to verify the old seal rather than pretending the old collector supported
FIFOs. Original launch and workspace ownership files remain unchanged.

The permanent command is:

`python scripts/tests/cloudbench-bootstrap-recovery.test.py ControllerExportContinuationTests.test_original_run_fifo_capture_is_metadata_only_and_truthful_tool`

The same case against the actual original collector failed at line 209 in
0.026 seconds. The candidate's complete twelve-case family passed in 0.359
seconds. Root independently ran that family: twelve passed in 0.394 seconds.
The controls forbid FIFO `os.open`, preserve the original inode and ownership,
verify the complete seal and continued launch, and reject metadata drift,
wrong types, changed tool bytes and forged external launch records. Independent
source/proof review accepted the exact candidate without rerunning load.

The corrected capture tool is published. The same original controller then
completed export and canonical verification with its original source, launch,
ownership and driver identity unchanged. Both FIFO metadata members are in the
314,408,552-byte archive, SHA
`fa93011342ec4d49b228ff7c22ed7aa7ffdaa8867918d39b967d142d90928a05`.
The manifest SHA is
`2988223093b79ee7332247bc516d106535a9ce53ccd8490c91379b34179185f9`.
The typed original receipt SHA is
`a43ef969ac16b58dd10a70facd0118dcc8919cd40c29bee5043e06d6573fc4eb`;
it records export zero, canonical verification zero and the original driver
resumed. Durable local transfer and another local verification follow separately.
This fixes the original archive failure; it grants no task grade, native release
or 600-task qualification credit.

## Related current-cold consumer failure (2026-10-16)

Five next39 source rows refused at `current_cold_files -> read` with
`unsafe original evidence file`. The subsequent guarded diagnostic identified
exactly `run/.native-retirement.pipe` for each: FIFO type4096, mode4516,
size0, uid/gid1001 and nlink1. It opened no FIFO content. The rows remain
excluded until a new root-owned source/custody transaction proves them; this
local repair grants no admission or qualification credit.

Archive searches used `unsafe original evidence file` and `retained retirement
FIFO`. This is a related consumer-contract recurrence: controller export already
preserved typed FIFO metadata, while current-cold capture still modeled every
original as regular-file bytes. Its regular-file refusal was correct; treating
IPC content as bytes or dropping the entry would be the wrong repair.

The registered canonical capture test
`AllocatedCurrentColdTests.test_retained_run_fifo_is_typed_custody_without_content_open`
reproduces the exact ValueError against unchanged534614ab1. The test intercepts
the old open boundary and supplies its real FIFO stat on a harmless descriptor,
so even the RED execution never opens the pipe. The same unchanged test then
exercises capture, commit, archive hash/type validation and local revalidation.

The additive current-cold format retains its regular-byte map. A generated
`source-fifos.json` inventory binds the exact original absolute path and stat;
`manifest.fifos` mirrors that typed record, and the archive includes a real
`FIFOTYPE` member with the existing `cloudbench.fifo-source-stat` PAX convention.
There is no regular-byte stand-in for the FIFO. The only supported special entry
is the canonical run-level retirement pipe, with zero size, one link and exact
source owner/group. Device/inode, mode, nanosecond mtime/ctime, UID/GID, size,
link count and allocation metadata are retained. Old regular-only archives stay
readable, and preconfig archives still reject special members.

Capture compares the complete typed inventory after writing, commit compares it
again, and current receipt verification enumerates and checks every physical
entry. Type, path, owner, link, metadata or inventory drift refuses. The original
terminal/owner, native identity, guest isolation and caller source-quiescence
guards remain mandatory; this does not fabricate successful producer cleanup.
Other nonregular entries refuse before open during current-cold inventory
traversal. The shared historical guest reader remains byte-for-byte unchanged.
Six registered FIFO cases passed five unchanged runs, including sealed source
handoff and destination verification. The existing34-case current-cold family
also passed five unchanged runs before adding that final handoff case.
No provider, guest, live-packet or original-source operation was performed by
this repair. Exact native revalidation remains root-owned.

### Compatibility correction during integration

The initial typed-FIFO patch also added a redundant `lstat` precheck to shared
`read()`. Combined source-import checks caught that this changed the historical
guest semantic AST: 12 errors across 13 import/successor tests, and the authentic
206655-byte `982d377ade3a4e96f414cde1d4d658e30dd8dc72ae07b75dbababe9bcd0527ea`
packet replay failed at `original collector guest semantics differ from trusted
source`. No original capsule bytes were changed to hide that mismatch.

The compatibility correction removes only that two-line shared-reader change.
Its AST again exactly matches the approved source. Host inventory traversal
retains its local nonregular precheck and typed FIFO handling. No new historical
hash allowlist entry, AST normalization exception, or guest-semantic waiver is
introduced. The identical13-test import/successor family and actual packet replay passed
five unchanged runs on the corrected source. The combined52-test current-cold,
import, source-successor and snapshot-representation check also passed.

## Human feedback

The user required continued repair, reuse of owned resources, protection of warm
capacity and evidence, and concrete cost control. The user also required that
infrastructure progress remain separate from the unchanged 600-task outcome.
No instruction authorized deleting retained IPC state to make an archive pass.

## Reusable lesson

Archive legitimate retained IPC as verified metadata without opening it, and
bind the actual capture tool separately from the immutable original run source.
