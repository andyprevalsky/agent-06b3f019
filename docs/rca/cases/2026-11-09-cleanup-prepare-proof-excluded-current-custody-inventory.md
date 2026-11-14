---
id: 2026-11-09-cleanup-prepare-proof-excluded-current-custody-inventory
date: 2026-11-09
title: Cleanup prepare proof excluded the current custody inventory
surface: infra
component: deploy-test-native-prepare
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup reconciliation rejected the original producer combination before validating its twelve active tasks and historical custody
symptoms:
  - native cleanup: prepare producer changed
  - insufficient physical cleanup cohort floors
tags:
  - deploy
  - cleanup
  - custody
  - source-pins
sources:
  - PR #1881
  - commit 7b68f4f7cde6a8cd1c4edfcbe119f1514b706045
  - fleet run deploy-8b393ce650a573ed61ba85fc4fddc63bbe431d118b612682b9373bc284796d7b
repro: scripts/tests/deploy-test-cycle.test.py
status: mitigated
---

## Problem

The twelve-task smoke campaign failed during cleanup-ticket preparation before
any task controller started. All twelve outcomes remained UNVERIFIED; the
adapter retained its cleanup owner. The original campaign reported
`insufficient physical cleanup cohort floors`. Subsequent cleanup reconciliation
failed separately with `native cleanup: prepare producer changed`.

## Diagnosis

Physical admission correctly enforced the existing preferred 512 MiB, minimum
32 MiB and headroom 256 MiB policy, including the additional nested slot. A later
observation found 3,901,255,680 free bytes against a 3,925,868,544-byte minimum
for thirteen slots. The failed-time numeric sample was not captured; neither
the later measurement nor source equivalence proves which activity consumed
the original space. This is not evidence that the floors should be lowered.

The cleanup proof recognized two older complete producer combinations and
fourteen unskipped tasks. This operation instead had twelve active tasks and
one historical no-retry custody entry. The guard correctly refused an
unrecognized contract. Its grant lookup also assumed a directory at the
worktree's `.git`, rather than the producer's actual Git common directory.
Those recovery assumptions could not certify this operation's positive
no-allocation and process-retirement evidence.

The original validator and the unchanged new regression both failed at the
producer guard. A candidate accepting only three custody labels or a summary
width was insufficient: independent negative controls demonstrated acceptance
of forged custody contents and contradictory native command concurrency.

## Solution

Recognize only the reviewed complete original producer combination, exact
source and inventory, full original custody certificate, and exact native
command. Bind custody to the original receipt as well as its canonical digest.
Resolve grants through the existing Git common-directory ownership helper.
Preserve the older fourteen-task contracts and all positive evidence guards:
empty native allocation directories, absent grant, immutable file hashes,
original process births, supervisor and relay closure, publication, and no
active evidence writer. Reject forged custody, command width changes and any
execution or financial credit.

The actual unchanged native proof validates locally with zero credit. The ten
owning cleanup-prepare tests passed five consecutive runs, including both new
adversarial regressions; those two tests also passed five focused repetitions. This is cleanup-proof repair evidence, not
a smoke task pass. Original receipts, cancellation clocks and UNVERIFIED
outcomes remain immutable; supported reconciliation and fresh normal execution
are separate obligations.

Operational recovery retained the SHA256-verified original Actions ZIP and
native controls while retiring only its byte-identical extracted payload, then
cleared an inactive npm download cache. Free space rose to 7,850,471,424 bytes.
No floor, task, timeout, concurrency or coverage requirement changed. These
coordinator-only checks add no operation to the production agent hot path.

The earlier shared-preflight stale-pin incident is a related integration
failure. Its requirement to review exact dependency bytes applies here; its
different startup protocol does not prove this operation's cleanup or explain
the physical refusal.

## Human feedback

None recorded.

## Reusable lesson

Bind cleanup recovery to the full original source, command, custody and physical grant identity before retiring launch ownership.
