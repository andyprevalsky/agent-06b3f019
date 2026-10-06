---
id: 2026-10-06-mac-casefold-class-reexports-diverged-worker-generation-hash
date: 2026-10-06
title: Mac case-folded class re-exports changed the worker-generation verification hash
surface: harness
component: agent-workflow-surface-hash
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _resolve_local_module accepted case-insensitive class-name aliases as additional local module paths
symptoms:
  - Cooperative cutover phase: awaiting_pointer_flip
  - live pointer: hash=d122110f8ac9
  - expected: hash=c1e4ae155271
tags:
  - temporal
  - generation
  - filesystem
  - case-sensitivity
  - verification
sources:
  - PR #1419
  - commit 063bc3c639b088d77b7df718706f239279616bb3
  - task exact Fly verification of workflow 37432126476 attempt 1
repro: scripts/tests/agent-surface-hash.test.sh class re-export and exact-case module controls
status: fixed
---

## Problem

The exact merged Fly workflow succeeded, but local authoritative cutover
verification failed. Its monitor already read the live production generation
`d122110f8ac9` while expecting `c1e4ae155271`, so it reported
`awaiting_pointer_flip`. The original failed Fly receipt and dependent semantic
attempt remain failed, with no credit assigned retroactively.

## Diagnosis

The supervisor ran the normal generation CLI under pinned Python 3.11.9. That
CLI reads no environment configuration: it follows local imports and hashes
source paths plus bytes. On the Mac, its closure contained 274 paths, including
`agents/keycap/Controller.py` and `Plant.py`. Those names are class re-exports;
the committed files are lowercase `controller.py` and `plant.py`. A
case-insensitive filesystem answers the inferred uppercase paths as files,
although a case-sensitive Linux checkout does not. The walker then hashed the
same physical source under additional spelled paths.

Every tracked surface byte matched the immutable merge. Removing only those
two analysis aliases produced 272 paths and `d122110f8ac9`, matching the actual
CI generation. Independent CI evidence bound the successful exact run/attempt,
new generation 8/8 started, pointer flip, old queue drain from 2 to 0, and normal
retirement without SLO force. This was a local generation-identity defect;
neither a missing production flip nor a timeout explains the failed comparison.
Three archive searches found related deployment/filesystem incidents but no
record of this exact class-re-export cause.

## Solution

The repaired CLI requires every inferred local path component to match an
actual parent-directory entry exactly. It leaves the import traversal,
relative re-exports, source bytes and digest algorithm intact. Unlike dropping
uppercase names generally, this preserves genuinely uppercase modules and
mixed-case packages. It also rejects aliases in directory components.

The existing unconditional `agent-surface-hash` owner gains an actual Mac
class-re-export negative, exact uppercase module and mixed-case package
positives, and an inverse proving a real uppercase-module edit changes the
hash. Identical test bytes failed on the unchanged tool in 0.269 seconds and
passed the complete existing owner with the private candidate in 2.682 seconds.
An independent Mac run of the identical owner also failed on the original
tool in 0.266 seconds and passed with the candidate in 2.610 seconds.
The candidate's actual Mac tree produces the same 272-path CI generation.
The existing import-scope, relative-re-export, content-edit, revert and
out-of-scope controls remain unchanged.

Independent execution on the exact merged Git export in case-sensitive Linux
took 11.162 seconds. The candidate's full 272-path vector and full digest
`d122110f8ac91ebd76d208ba4fa2ba7503d6f070e1efa9f7f7db2153ff20cc5e`
equaled the original merged Linux result exactly. The owned offline container
was removed and its native absence verified. Normal single-file formatting
preserved the candidate's complete AST.

The repair is applied; its complete existing owner passes on the final
formatted Mac tool. Ruff, Bash syntax and diff checks pass. Follow-up review
and merge remain pending. Production continuation used the independently
bound exact merged Linux generation: the normal direct verification and
45-case rollout matrix, including fixture cleanup, passed in 338.824 seconds.
All five captured process identities were absent afterward. The original
failed local receipt remains preserved. No deploy reset, force migration or
paid replay was needed to diagnose or correct this identity mismatch.

This changes only the deployment generation CLI and its owning controls.
It changes no Linux workflow source, tasks, evaluators, prompts, provider calls,
timeouts or default budgets. At 10,000 tasks, no per-task work is added: exact
entry checks occur only during generation derivation. The unchanged deployment
workflow path rules do not trigger a Fly rollout for this script/test/docs-only
follow-up.

## Human feedback

None recorded for this defect.

## Reusable lesson

Resolve inferred module paths with the production filesystem's exact-case
semantics before comparing content-addressed generation identities across hosts.
