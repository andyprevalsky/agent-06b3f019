---
id: 2026-09-27-cloud-controller-temp-root-ignored-persistent-volume
date: 2026-09-27
title: Cloud controller fixtures used the constrained root filesystem instead of the owned data volume
surface: infra
component: cloud-controller-setup
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The private Linux validation launcher exported TMPDIR=/var/tmp although its available storage was on /data
symptoms:
  - "could not allocate the emergency fleet teardown disk reserve; refusing provider mutation"
  - "workstream A's provisioning must succeed alongside a concurrent run (exit=1)"
  - concurrent provisioning fails before the primary runtime evidence fixture
tags:
  - cloudbench
  - linux
  - temporary-storage
  - disk-reserve
  - concurrent-provisioning
sources:
  - PR #1299
  - commit 9f3266b699347c42d614eadff6451b773e9cce29
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: open
---

## Problem

The unchanged full multi-workstream test exited 1 on the owned Linux controller
after 98.5 seconds. Workstream A refused to allocate its teardown reserve;
workstream B provisioned its isolated fake pool successfully. The failure was
before the runtime-evidence scenarios. Its actual native exit and log remain in
the private artifact directory
.context/acceptance/proof21-r2-multi-workstream/.

The launcher used TMPDIR=/var/tmp. Native filesystem observations showed
1,087,102,976 bytes available there, on the same device as the root filesystem.
The separate owned /data volume had 94,012,354,560 available bytes. The test
creates its scratch repository and both worktrees beneath TMPDIR, so their
real cleanup-reserve files also landed on the constrained root filesystem.

## Diagnosis

The path was validation launcher environment → scratch repository → concurrent
fleet registries → unchanged physical reserve allocation and headroom check.
The default reserve is 512 MiB per controller with 256 MiB operating headroom.
Both allocations cannot fit together on the observed root filesystem while
preserving that headroom. Runtime correctly refused unsafe admission.

Archive searches used the literal reserve-refusal message and
"cloud tmp filesystem disk reserve concurrent provisioning". The
[hosted-runner checkpoint case](2026-07-24-runner-disk-exhaustion-lost-unpushed-rca-checkpoint.md)
is a relative concerning durability after host exhaustion. It does not own this
configuration boundary; no exact prior case was found.

A first reduced allocation probe stopped at its own 30-second wait and is
preserved as an inconclusive reduction, not causal RED evidence. The subsequent
probe used the exact existing test prefix through scenario 1, including all
original provisioning and isolation assertions. Its only extraction adjustment
bound the repository root to the original checkout. Both phases executed the
same payload; only TMPDIR differed.

## Solution

Use /data/controller-tmp, a private directory on the verified owned data volume
outside the checkout, for the controller's temporary files. Apply that setting
consistently to the validation parent and its gate subprocesses. Require mode
0700, no symlink, and the same filesystem device as /data. Keeping the directory
outside the checkout also follows CLAUDE.md's archive-path guidance: production
archive guards classify repository descendants as repository-local storage.
No reserve, headroom, concurrency, workload or benchmark limit changed. No
production code or test assertion changed for this configuration repair.

The command "agents/venv/bin/python .context/setup/reproduce-proof21-tmpdir.py"
ran the identical scenario prefix first on /var/tmp and then on the owned data
volume at /data/rose-pr1299/.context/controller-tmp. That original GREEN used
the inside-checkout path on the same /data filesystem; it is not evidence of
execution at the subsequently selected outside-checkout path. The probe
recorded native exit 1 in 97.98 seconds with the same reserve refusal,
then native exit 0 in 53.91 seconds with both concurrent provisioning assertions
passing. The retained supervisor exited 0 and its exact native birth was absent.
The common payload SHA256 is
c3d0f69145f4bca0a224112da2d971eb9024aa4bdb699f0573dd0ec7a71033d2.

The original test already provides permanent concurrent reserve coverage and
remains in the full controller gate. Private artifacts under
.context/acceptance/proof21-cloud-temp-storage-rca/ retain the filesystem
observations, excluded reduction, exact prefix, native receipts and both logs.
Independent review at independent-review/review.json verifies those bytes and
the environment-only change. The full multi-workstream test and final
controller gates still need to finish on the corrected environment; this case
remains open and grants no live cloud slice credit.

## Human feedback

The user requires infrastructure reliability with ten consecutive slices of
ten real benchmarks and at least three successful LLM calls per benchmark.
Keep the ordinary 120-minute backstop and use five minutes for this diagnostic
campaign. Do not change tasks, evaluators or limits to manufacture success.

## Reusable lesson

Place controller temporary workloads on the filesystem whose capacity was verified, and retain the original concurrent reserve and headroom requirements.
