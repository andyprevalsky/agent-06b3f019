---
id: 2026-11-16-project-restore-eagerly-transferred-historical-blobs
date: 2026-11-16
title: Project restore eagerly downloaded historical blobs before starting the code CLI
surface: back-end
component: project-workspace
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/projects/workspace.ts cloneInto unfiltered remote clone
symptoms:
  - Timeout after 304s (task timeout=300s)
  - Agent status ACTIVE (expected COMPLETED)
  - Restored project workspace
  - claude-code-agent
tags:
  - e2b
  - git
  - session-preparation
  - latency
sources:
  - agent b1ca94e7-83aa-4358-9768-204b5748aabd
  - commit f14f0cc030f288d2212c8d76acdd63043a3ed679
repro: back-end/src/tests/blackbox/project-clone.blackbox.ts
status: open
---

## Problem

Required smoke/claude-code-agent exceeded its unchanged 300s deadline with the
root ACTIVE, despite the Claude child eventually completing the original
Collatz calculation successfully (111 steps, 112 numbers). The original native
run was 20261116-172041-1920615, source 0b971856198c5fe9e65ae3422ac0cfce81c5b8ce.
The encrypted trace manifest is
r2://trace-archive/trace-archive/b1ca94e7-83aa-4358-9768-204b5748aabd/manifest.json.gz.enc.
Original evidence packet SHA256:
d8b68d2968f6867595ef5a66c8b770156428c3f208edfe6d1b3703a554e243e6.

## Diagnosis

Critical path: root spawn -> session create -> acquire sandbox -> overlay ->
HOME files -> project restore -> CLI -> handoff -> root final completion.
The original raw backend log shows sandbox acquisition complete at
17:48:38.029Z, overlay complete at 17:48:38.602Z, HOME materialization complete
at 17:48:38.940Z, and remote project restore complete at 17:51:24.923Z,
files=0, warnings=0. Attachments were absent. Acquisition is not the 166s gap.

An isolated real E2B restore of the Rose repository at current main
f14f0cc030f288d2212c8d76acdd63043a3ed679, revision 0, no synced files/bundle,
using the actual restoreSandboxProject path and default Claude template,
measured 224711ms overall: 223899ms was git clone; all remaining restore
operations together took 812ms. Its owned sandbox was killed in finally.
The original run lacks a per-command clone span, so its precise clone duration
cannot be recovered. The reproduction captures that previously missing boundary.

Why: cloneInto ran an unfiltered clone, requiring every historical blob before
checkout and CLI start. Why possible: the generic remote restore policy copied
bundle semantics to remote Git repositories, making startup cost grow with
history unrelated to the task. Complete commit history does not require eager
transfer of all historical file contents. The assertion-first regression uses
a filter-capable local Git upload-pack and an obsolete incompressible artifact;
unmodified restore downloads that artifact and fails the assertion.

Archive searches: `claude-code-agent Timeout after 304s` and
`sandbox preparation overlay workspace latency`. The October 2 Claude stream
watchdog case is a relative: that child stalled, this child completed. The
November 6 code-agent startup observability case is a relative; this incident
adds the missing clone boundary and tests transfer behavior. Neither establishes
this incident's cause independently. Existing #2358 transaction-timeout repair
was reconciled and does not overlap the project clone policy. No matching open
project-clone repair was found among open PRs.

## Solution

Remote clones use Git's blobless partial clone. All commits, branches and current
workspace files remain available; historical blobs load from the promisor remote
on demand. Bundle restoration remains unfiltered. Clone duration is logged
without source URLs, credentials or file contents. This removes historical-blob
transfer from both Claude and Codex project preparation, at their shared owner.
No shared queue, per-root lock or global cache is introduced; at 10k sessions
each restore retains its own sandbox and reduces network/disk work independently.

The identical focused command is
`cd back-end && node --import tsx --test src/tests/blackbox/project-clone.blackbox.ts`.
Before: exit 1, `session preparation must not transfer obsolete historical blobs`.
After: exit 0. Negative controls assert current-tree bytes, complete commit
history and exact historical bytes fetched on demand. Native affected-test
stability runner passed 5/5 under load (101s); deploy mapping resolves to
`backend-blackbox project-clone`. Real after-fix E2B comparison, original smoke
contract, independent review and deployment remain pending; no fixed outcome
is claimed yet. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Preserve the original Collatz task, tool counts, assertions, concurrency,
COMPLETED status and 300s timeout. A later isolated pass, instrumentation-only
report, quarantine or attribution does not complete this assigned repair.

## Reusable lesson

Measure remote restore at its Git boundary and preserve complete history without eagerly transferring obsolete file contents before session startup.
