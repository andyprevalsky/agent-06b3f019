---
id: 2026-09-27-env-tree-fixture-treated-terminal-zombies-as-live
date: 2026-09-27
title: Environment tree fixture treated terminal zombies as executing descendants
surface: harness
component: cloudbench-env-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-env.test.sh used kill -0 as a descendant execution-state assertion after canonical tree cleanup
symptoms:
  - "FAIL: tracked controller descendants must not survive tree cleanup"
  - Linux controller exits before the multi-workstream suite starts
  - same native descendant birth is Z under PID1 while kill -0 succeeds
tags:
  - cloudbench
  - linux
  - darwin
  - zombie
  - process-identity
  - fixture
sources:
  - PR #1299
  - commit 31a9bd8fcdbdfd3054e104e8bd464a3354163c82
repro: scripts/tests/cloudbench-env.test.sh
status: open
---

## Problem

The final Linux controller on `31a9bd8f` exited 1 after 18.84 seconds at
`FAIL: tracked controller descendants must not survive tree cleanup`. The
multi-workstream suite had not started. Its retained log did not capture the
failed descendant's PID or state; that historical state remains unknown.
The previous validation route ran the environment and GitHub shell tests on
macOS and the remaining controller tests on Linux. Running the same commands
on the owned Linux host exposed this assertion's platform-dependent behavior.

The unchanged focused tree replay on that host returned 1 with the same error.
Its waited root was absent; the captured leaf and sleep process retained their
native birth identities but were `Z`, reparented to PID1. `kill -0` succeeded,
although neither could execute. The late-write marker remained absent. This
reproduces the mechanism without asserting unrecorded historical PID state.
Evidence is under `.context/acceptance/proof21-cloud-env-rca/`; the original
controller log and native exit are in `proof21-cloud-controller-monitor/`.

## Diagnosis

Archive searches were `tracked controller descendants must not survive tree
cleanup` and `Linux zombie process tree kill -0 cleanup`. No exact prior case
owned this assertion. The [Hub fixture join case](2026-09-11-hub-fixture-wait-after-birth-rejection.md)
and [missing-proc fixture case](2026-09-11-pytest-cleanup-treated-missing-proc-as-no-children.md)
are relatives with different first bad boundaries: an unconditional join after
rejected ownership, and incomplete descendant discovery, respectively.

The path was real Bash process forest → canonical
`cloudbench_terminate_tree_and_wait` → native terminal state → fixture assertion.
The production helper already revalidates captured births and treats a zombie
as terminal while rejecting live or unknown survivors. The fixture instead
conflated numeric PID existence with ability to execute, making success depend
on when PID1 reaped an already terminal descendant. This is a test contract
error, not evidence of failed runtime teardown.

The first promoted replay happened to pass because its descendants were reaped
before observation; `promoted-before.json` preserves that outcome. The permanent
control therefore holds its own exited child unreaped until after the assertion,
then always joins that exact `Popen`. This produces deterministic red evidence
without changing cleanup signals, the one-second cleanup bound, or PID1.

A Mac check exposed a related draft assertion error: `proc_pidinfo` cannot read
a zombie's native identity and raises `ValueError` for an absent PID. The final
assertion proves absence with `kill(pid, 0)` returning `ProcessLookupError`, or
accepts a successful strict native `ps` Z state. A positive Z observation proves
no execution even when Darwin cannot return its birth; a replacement's readable
native birth also proves the original process ended. Live, malformed and
unavailable observations fail closed. This helper authorizes no signals.

## Solution

Only the existing environment test changes. Its independent assertion retains
the original direct-root absence check and late-write check, and adds real live,
unreaped-zombie, joined-child absence and failed-state-probe controls. The live
TERM-resistant descendant must fail the terminal assertion before cleanup.
After canonical cleanup it must be absent, replaced, or positively terminal.

Deleting the PID-existence assumption removes the demonstrated mismatch;
changing production teardown or waiting for a foreign PID1 to reap would alter
the wrong owner. The assertion uses the existing native identity reader and an
independent bounded state query. Production code, task definitions, evaluators,
models, prompts and benchmark limits remain unchanged.

Final paired evidence uses the same permanent assertion body with only the
predicate implementation changed. Run the preserved `final-before-remote.py`
and `final-after-remote.py` through the existing exact-host `guest.py` execute
entrypoint; the recorded child command is `/bin/bash <focused.sh> <output>`.
The local command that generated and ran both is `agents/venv/bin/python
.context/acceptance/proof21-cloud-env-rca/run-final-focused.py`.
`final-before.json` records native exit 1 at `terminal predicate rejected a
non-executing exact zombie`; `final-after.json` records native exit 0 in 1.87
seconds. Their executed payload hashes are explicitly separate from the
unchanged remote checkout hashes. The current permanent test SHA256 is
`3e58a2e6b6b4fae7fc835ebb052e1749b0eda0f13465aca02ff6991d9fadb8c3`.

`final-macos.json` records the same final permanent block passing in 1.71 seconds
with `/opt/homebrew/bin/bash .../final-macos.sh`. The earlier failed Mac receipt
`focused-macos-after.json` remains preserved. All direct fixture children were
joined; no emergency signals or late writes occurred in the final Linux replay.

The owning route remains `bash scripts/tests/cloudbench-env.test.sh`, already
called by the full controller gate. The final whole controller run on the new
committed head is still pending, so this case remains open. Focused regression
proof does not confer a cloud slice or 100-run acceptance credit.

## Human feedback

The user requires infrastructure-only changes, trustworthy execution and
teardown throughout each run, ten consecutive slices of ten real benchmarks,
and a five-minute per-benchmark limit. Task PASSED or FAILED can qualify when
infrastructure is correct; changing task behavior or evaluation to improve
success does not. This correction is confined to the offline fixture assertion.

## Reusable lesson

Assert terminal execution state independently of PID existence, and reject live or unobservable descendants while always joining directly owned children.
