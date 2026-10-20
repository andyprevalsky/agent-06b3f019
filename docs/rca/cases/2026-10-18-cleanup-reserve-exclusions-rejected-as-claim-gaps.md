---
id: 2026-10-18-cleanup-reserve-exclusions-rejected-as-claim-gaps
date: 2026-10-18
title: Canonical cleanup reserve exclusions were rejected as claim evidence gaps
surface: infra
component: cloudbench-unused-reservations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: archive_members rejects every manifest exclusion before distinguishing the canonical collector's physical cleanup reserve payloads from claim records
symptoms:
  - archive exclusions cannot prove claim absence
  - first full600 batch preparation failed before reservations or controller creation
  - physical cleanup reserve; payload never read
tags:
  - cloudbench
  - archived-reuse
  - cleanup-reserve
  - archive-exclusions
sources:
  - commit 02c195ef05fb5dcc41f2048c3fb0bd867580f46b
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - fleet run original600-1792287037097809581
  - fleet run original600-1792279176545861179
repro: python3 scripts/tests/cloudbench-unused-reservations.test.py
status: open
---

## Problem

The first preparation for a requested three-run full600 timing batch stopped at
`archive_members` with `archive exclusions cannot prove claim absence`. The
attempt lasted 46.035202189 seconds and created no reservations, controller, or
physical task attempts. Original77's archive had already passed the unchanged
canonical collector verification and its controller resources were released.
Its manifest records 42 exclusions, all named
`git-common/cloudbench-fleet-ownership/<32-hex-token>/cleanup-disk-reserve`.
Every recorded object is a private regular file with one link; 41 contain
148897792 bytes and one has zero bytes. Their payload was deliberately omitted,
not captured and later lost. The manifest SHA is
`4784c4389cf096e71c05364c7fc3aab4f6d7655164c244ce20216145963bd1ca`.

## Diagnosis

The path is canonical fleet reserve creation, canonical controller export,
verified archive, closed-reservation preparation, then absence-of-claim scanning.
Collector source `ff7681d3eefde5df2c678cb0f900b66cb2427cf39180c0ed9a5c28e7dd721c1b`
omits exactly a file named `cleanup-disk-reserve` beneath the physical Git common
directory's fleet ownership token directory. It records the original path,
complete stat metadata and exact reason, and checks that its metadata remains
unchanged through export. The reader instead rejects any nonempty `excluded`
map before scanning claims. The producer and consumer disagree about whether
that non-claim payload must be archived. No provider or task failure caused this
preparation error.

Archive searches used `archive exclusions cannot prove claim absence` and
`cleanup reserve omitted archive closed world unused reservations`. The
inventory-generation-pointer case is a relative: another producer-owned artifact
was mistaken for ambiguous claim evidence, but its first-bad predicate was the
alias guard rather than the exclusion guard. The earlier correction therefore
does not establish this cause or cover the omitted payload contract.

Golden-reference inspection found explicit archive exclusion inventory checks
in `openclaw/src/commands/backup-verify-manifest.ts:126`: excluded roots cannot
conflict with retained resource inventory or retained entries. Hermes excludes
nonportable live sockets in `tools/environments/vercel_sandbox.py:337`. These
are design analogies, not proof of claim absence. Searches of Claude Code and
Codex found no matching fleet-reserve claim reader.

## Solution

Validate the producer's one explicit non-claim exclusion contract at the reader.
Accept only its exact tokenized reserve path, source-path mapping, known
collector binding, physical containing directories and private single-link
regular-file metadata. Require excluded paths to be absent from both the
retained manifest file map and physical tar members. Preserve every ordinary
claim scan, imported-request hash, alias denial, current-native check and denial
of all other exclusions. Omitted reserve payloads confer no claim or capacity
credit. Do not rewrite the old archive, include reserve payloads merely to evade
the guard, or drop the previous run from history.

Removing all exclusion validation would permit missing claim evidence. Changing
the already-correct producer to copy many gigabytes of non-claim disk reserves
would retain the duplicated contract and increase export time. A narrow shared
producer-contract validation is the smallest coherent correction.

## Verification and limits

The permanent owning regression calls the actual `collector.export` and its
unmodified `sources()` enumeration, then full `U.prepare`. On the original
02c195 reader, the unchanged regression
`python3 scripts/tests/cloudbench-unused-reservations.test.py Unused.test_canonical_export_cleanup_reserve_is_zero_credit_metadata`
failed with the exact exclusion error; root observed exit 1 in 0.246527 seconds.
The corrected reader passed all 22 existing owning tests in 4.815 seconds in the
composed checkout. The fixture includes zero-byte reserve metadata and seven
foreign reason, escaping path, claim path, nonprivate mode, alias, source and
hardlink denials. The author's explicit Ruff check passed. Root's Python has no
Ruff module, so the author lint result is retained against the exact copied
source hashes rather than misreported as a second root lint run.

Independent review caught and corrected an initial fixture that synthesized a
`git-common` archive root. Production archives its selected children instead;
the final fixture uses the unmodified source enumeration and requires physical
registry and token parents while binding the common directory through its
sealed root anchor. The actual 42-entry metadata calibration also passed. The
full actual preparation and successful 600-task execution remain separate,
unmeasured outcomes; this case stays open until those results are recorded.

### Actual-input follow-up: canonical root anchor has no GID

The next real preparation on 87ef40 stopped before effects at `unsafe cleanup
reserve metadata`. The archived launch anchor contains exactly `device`,
`inode`, `mode` and `uid`; it has no `gid`. All 42 reserve metadata records
otherwise passed the new predicate. The reader's additional comparison of a
file's integer GID to `anchor.get("gid")` therefore compared 1001 with `None`.
The first fixture had used the collector's full nine-field `file_state` result
as a launch anchor instead of the four-field projection in `collector.launch`.
Its partial metadata calibration inherited that assumption and missed the real
launch schema. This was a consumer/fixture error, not a provider failure.

Remove only the unsupported GID-to-anchor comparison, retain the UID, private
single-link and all other checks, and construct the permanent full preparation
fixture with the canonical four-field anchor. The identical fixture fails on
87ef40 and passes after the correction; the author passed all 22 owners in
4.458 seconds. Root independently replayed the complete actual manifest with
SHA `4784c4389cf096e71c05364c7fc3aab4f6d7655164c244ce20216145963bd1ca`:
the old predicate rejects it and the corrected predicate validates exactly all
42 exclusions with zero capacity credit and no provider calls. Full actual
saved-inventory preparation remains the executor's next outcome check before
another live admission. Both failed preparations remain in the original batch
wall and monotonic total and do not count as completed experiments.

## Human feedback

The user reduced the timing request from ten runs to three full experiments,
then explicitly instructed agents to stop asking for approval and continue the
necessary benchmark fixes. Preserve the failed preparation and batch wall and
monotonic origin. Report actual execution and cleanup durations without treating
this zero-task preparation failure as one of the three completed experiments.

## Reusable lesson

Validate producer-declared non-claim omissions explicitly while retaining a complete closed-world scan of every path that can carry claim authority.
