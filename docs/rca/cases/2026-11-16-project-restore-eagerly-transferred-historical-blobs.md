---
id: 2026-11-16-project-restore-eagerly-transferred-historical-blobs
date: 2026-11-16
title: E2B project restoration thrashed Git's delta-base cache before starting the CLI
surface: back-end
component: project-workspace
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/projects/workspace.ts cloneInto and git used Git's default delta cache for large E2B project histories
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
  - PR #2415
repro: back-end/src/tests/blackbox/project-clone.blackbox.ts
status: open
---

## Problem

Required smoke/claude-code-agent exceeded its unchanged 300s deadline with the
root ACTIVE, despite the Claude child completing the original Collatz
calculation (111 steps, 112 numbers). Original run:
20261116-172041-1920615, source 0b971856198c5fe9e65ae3422ac0cfce81c5b8ce.
The original trace manifest is
r2://trace-archive/trace-archive/b1ca94e7-83aa-4358-9768-204b5748aabd/manifest.json.gz.enc.
Original evidence packet SHA256:
d8b68d2968f6867595ef5a66c8b770156428c3f208edfe6d1b3703a554e243e6.

## Diagnosis

Critical path: root spawn -> session create -> sandbox acquisition -> overlay
-> HOME files -> project restore -> CLI -> handoff -> root final completion.
The original raw backend log shows acquisition complete at 17:48:38.029Z,
overlay complete at 17:48:38.602Z, HOME materialization complete at
17:48:38.940Z, and remote project restore complete at 17:51:24.923Z,
files=0, warnings=0. Attachments were absent. Acquisition is not the 166s gap.

An isolated real E2B restore through restoreSandboxProject, the default
2-vCPU/4-GiB Claude template, and the same Rose repository measured 224711ms:
223899ms in clone, 812ms elsewhere. It restored main f14f0cc and released its
owned sandbox. A separate traced unfiltered main-only control took 201328ms,
including approximately 108s in transport, a further 67s before checkout, and
24s materializing files. Removing other branches did not remove the delay.

Why clone was expensive: large historical blobs form delta chains. A current
101641599-byte history blob occupies only 83955 packed bytes and references
another base object. Git's default 96-MiB-per-thread delta-base cache repeatedly
prunes/reconstructs large bases. Git v2.34.1 builtin/index-pack.c explains the
owned dependency boundary: prune_base_data at line 380 evicts bases, while
get_base_data at line 843 reconstructs pruned ancestor chains, under the work
mutex (threaded_second_pass, line 1005). See the upstream source:
https://github.com/git/git/blob/v2.34.1/builtin/index-pack.c.

Controlled replay eliminates transport, checkout and source variance. Four
index-pack --verify runs used the identical immutable 1242277880-byte pack
pack-2c0be108e11c35592d665dfde4e1348aeff5957e.pack, all exit 0:

| Cache per thread | Child CPU seconds | Wall seconds |
| --- | ---: | ---: |
| 96 MiB | 262.741 | 135.904 |
| 512 MiB | 200.494 | 75.752 |
| 512 MiB | 196.750 | 74.331 |
| 96 MiB | 254.886 | 120.926 |

CPU accounting, rather than wall time, isolates the approximately 24% reduction
from scheduling and network variation. The fixed production restore path also
completed in 145230ms (clone 144562ms, remaining 668ms) and released its owned
sandbox. That clone fetched a later main (3128d97); its faster transport and
changed pack layout mean the entire 79s wall reduction cannot be attributed to
cache tuning. The original incident lacks a per-command span, so its exact
clone/transport/CPU split cannot be recovered. The controlled pack replay and
regression establish the expensive reconstruction mechanism; the unchanged
cloud smoke remains the original acceptance test.

Rejected hypotheses are retained: blobless-only checkout stalled for over
362s and was explicitly stopped/released; size-filtered and single-branch
blobless variants also stalled and were released. Staged shallow-then-complete
history took 360158ms; archive preparation triggered lazy metadata fetches and
hit its native command deadline. No partial/shallow/archive path ships. The
initial blob-deferral test did not reproduce the incident's latency mechanism;
it was replaced by the real-Git cache-pressure reproduction before acceptance.

Archive searches: `claude-code-agent Timeout after 304s` and
`sandbox preparation overlay workspace latency`. October 2's Claude stream
watchdog is a relative: that child stalled, this child completed. November 6's
startup observability case is a relative; this repair captures the clone
boundary and tests its actual CPU mechanism. Existing #2358's transaction
repair was reconciled; it does not overlap project Git configuration. Open PR
review found no matching project-clone repair.

## Solution

Use a 512-MiB-per-thread delta-base cache for E2B restore Git commands, including
initial clones and subsequent fetches. The default sandbox grid starts at
4 GiB; Git normally uses at most three index-pack threads, bounding this cache
at 1.5 GiB per sandbox. Local executors retain their existing configuration.
Clone start/end capture includes session identity, source kind and duration,
without URLs, credentials or file contents. Full clones, all history/refs,
project files, tool behavior, concurrency, output assertions and timeout remain
unchanged. The helper is shared by Claude and Codex project restoration.
At 10k sessions, each sandbox uses its own existing allocation; no shared cache,
queue, lock or fan-in is introduced.

Identical isolated command, before and after:
`cd back-end && node --import tsx --test src/tests/blackbox/project-clone.blackbox.ts`.
Before uses the exact original f14f0cc workspace blob
89dbc8c8cab66e2cbfa9729dfa33981970df12b0: exit 1,
`session preparation must avoid repeated delta-base reconstruction`,
23.433909 clone CPU seconds versus 11.288030 reference CPU seconds.
After: exit 0, 11.960606 versus 11.631840, with the same 1.6 ratio assertion.
The fixture scales the captured cache/base-size ratio down by 96 and preserves
the delta reconstruction mechanism using real Git. CPU comparison excludes
scheduler waits. Negative controls assert full history, another remote branch,
current/historical file bytes and restored private env-file mode. The test runs
in backend-blackbox/project-clone; the Python fixture has an explicit selection
edge. The official stability runner passed five consecutive unchanged runs under
8-slot CPU load (257s). Fresh cross-review, the original cloud task and full
deployment are in progress; no completed repair is claimed yet.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Preserve the original Collatz task, tool counts, assertions, concurrency,
COMPLETED status and 300s timeout. A later isolated pass, instrumentation-only
report, quarantine or attribution does not complete this assigned repair.

## Reusable lesson

Measure clone transport and reconstruction separately, then replay the identical pack before attributing preparation latency or changing the workspace contract.
