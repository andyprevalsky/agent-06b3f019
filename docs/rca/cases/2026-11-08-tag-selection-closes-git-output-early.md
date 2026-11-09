---
id: 2026-11-08-tag-selection-closes-git-output-early
date: 2026-11-08
title: Auto-tag Git producers fail with exit 141 when head closes selection pipes
surface: infra
component: mac-app-auto-tag
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: .github/workflows/auto-tag-mac-app.yml Create and push tag command substitutions pipe live git tag output into head under errexit and pipefail
symptoms:
  - "##[error]Process completed with exit code 141."
  - "auto-tag / Create and push tag exits before Release reason"
tags:
  - git
  - bash
  - pipefail
  - sigpipe
  - release
sources:
  - PR #1770
  - commit 5066feea73da4a966aa7655ccbc40ea8c26529a8
repro: scripts/tests/mac-app-autotag.test.py
status: fixed
---

## Problem

The native Auto-tag Mac App Release run on the originating merge exited 141 in
Create and push tag before its first runtime echo. The shared decision and
checkout steps succeeded. The original script used `/usr/bin/bash -e` and
`set -euo pipefail`. Its workflow blob `98626334ed87634e501ab831e46fabbfc28fe43d`
was identical on the failed merge, reviewed source and base: Gate: NOT_INTRODUCED
relative to PR #1770. This repair remains assigned regardless of attribution.
The preserved original log is authoritative; operational creation of v1.1.296
was neither a permanent repair nor proof that the release succeeded. That tag
has not been modified or recreated by this repair.

## Diagnosis

Critical path: merged event SHA → unchanged ship decision → exact checkout →
existing-target tag query → version-sorted tag query → increment → local ref →
non-forced remote push. Binary isolation reproduced native 141 at each live
producer/early-reader boundary: the existing-tag assignment with 20,000 tags
on the target, and the sorted-tag assignment with 20,000 tags on a different
commit. The original full step ran against real disposable Git repositories
and local bare remotes; no producer mocked exit 141 and no production refs
were used. Native syscall captures show `write(...)= -1 EPIPE`, SIGPIPE, and
pipeline statuses `141 0`. The pipe contract lets head succeed after one line
while Git is still writing; pipefail then makes the assignment fatal.

The original historical log lacks xtrace/PIPESTATUS, so it cannot distinguish
which of the two assignments failed. The repair removes both boundaries.
A single old local passing replay is preserved, not relabeled as a failure.
The investigator independently replayed Git 2.43.0: 227 tags / 1,914 bytes
passed 20/20; 317 captured names / 2,713 bytes passed 50/50; both 20,000-tag
cases failed 3/3. In the 317-name syscall trace Git emitted a single 2,713-byte
write, so those bytes alone do not establish buffer pressure. Full native
checkout logs identify checkout Git as 2.55.0, not the local 2.43.0; the later
run shell did not separately emit its resolved Git path/version.
The vanilla 2.55.0 build likewise passed 12 tags 20/20, 227 tags 20/20 and
317 names 50/50, while both 20,000-tag cases failed 3/3 with native 141.
Version alone therefore does not explain the historical small replay. The
historical command identity, complete runner configuration/build and exact
checkout ref state remain unrecorded; these limits are retained, not converted
into a claim that the original 317-name inventory overflowed a pipe.

Archive searches: `Process completed with exit code 141` and
`git tag head pipefail release selection`. The cloudbench target-mode
head-pipe case (2026-10-03) and kill-services grep case (2026-09-04) are
relatives: the same pipe contract defect in different owning code. Their
specific guards did not cover the auto-tag workflow. This is not a claim that
the already-fixed cloudbench code regressed.

What: successful selection becomes fatal 141. Where: live Git-to-head pipes.
Why: early reader closure violates the producer-completion requirement implied
by pipefail. Proof: unchanged workflow blackbox native failures and syscall
captures, followed by unchanged passing assertions. Deepest owned Problem:
selection must observe the producer's complete success before discarding rows.
The next why reaches intentional shell pipefail and OS pipe semantics; neither
should be weakened. Classification: our bug, inconsistent stream contract.
Golden reference: not applicable (no approval-gated hunk).

## Solution

Delete the early-exiting consumer: capture each complete Git query, preserve
its exit status, then select the first line with Bash parameter expansion.
Keep global concurrency, cancel policy, ship decision, checkout credential,
existing-tag semantics and release verification. Validate the selected latest
version rather than publishing a tag derived from malformed input. Create the
new tag explicitly at MERGE_SHA and push the fully qualified tag ref without
force. A collision remains a real failure and never overwrites the winner.
An ERR trap records the failing command, line and native status for subsequent
failures instead of leaving another pre-echo observability gap.

`python3 scripts/tests/mac-app-autotag.test.py` extracts the actual workflow
step and executes it with `/usr/bin/bash -e`. Final test SHA-256 is recorded
with the original and fixed logs in the repair evidence. The same eight-case
artifact failed on the original workflow and passed on the repaired workflow:
both 20,000-tag boundaries, small version sort and event-target identity,
existing nonversion tag, failed Git query, empty inventory, malformed version,
and a competing remote tag. The owning Mac release drift suite invokes it;
that existing suite is now registered in deploy-command-structural as well as
scripts/test.sh. Five consecutive unchanged full owning-suite runs passed.
This removes two subprocesses and adds no agent-dependent work: at 10,000
agents the per-release work remains one complete tag read per selection, with
the intentional existing global serialization and no per-agent queries.

## Human feedback

The user required actual unchanged blackbox fail/pass, preservation of the native
failure and all evidence gaps, no speculative buffer-pressure claim, no change
to v1.1.296, and completion of the independent deploy. Historical sandbox
payment custody must be restored before smoke; neither original stalled case
may be minted, reclaimed or reissued. Historical financial state stays UNVERIFIED.

## Reusable lesson

Capture a Git query to successful completion before selecting its first line under errexit and pipefail.
