---
id: 2026-09-11-port-collision-fixtures-orphaned-subshell-children
date: 2026-09-11
title: Port collision fixtures killed launcher shells and orphaned their HTTP servers
surface: harness
component: run-port-collision-structural-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Bash 3.2 fixture launchers recorded the subshell PID while the listening server ran in its child
symptoms:
  - run-port-collision passes but Python HTTP servers remain parented to PID 1
  - fixture listeners on ports 61000 through 61002 survive shell cleanup
tags:
  - bash
  - macos
  - subprocess
  - orphan
  - fixture-cleanup
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: scripts/tests/run-port-collision.test.sh
status: fixed
---

## Problem

The parallel structural run reported run-port-collision PASS but left Python
HTTP server PIDs 89068, 89399 and 90018 under PID 1. Their birth times matched the
gate. Their ports and working directories matched the delayed frontend,
foreign-directory and current-worktree fixtures exactly. The first two shared
the gate's unique temporary root. Native birth identities were captured before
each exact process was terminated; all three were then independently absent.

## Diagnosis

Three fixtures launched `(cd directory; python3 -m http.server ...) &` and
recorded `$!`. On macOS Bash 3.2, that PID belongs to the launcher subshell. The
cleanup trap killed and waited for that shell, leaving the server child alive.
The foreign-listener check also killed only its recorded shell before removing
it from the cleanup array. The test therefore passed without owning the
processes it had created.

A minimal native Bash 3.2 reproduction captured the shell-to-server parent
relationship and the child's native birth identity. Terminating the recorded
shell left the same child alive. Earlier Bash 5 probes optimized the launcher
into the server and did not reproduce this boundary; they are excluded from
causal evidence. A retained copy of the actual test with the new PID/listener
assertion and the original non-exec launchers fails at that assertion. Only
that deliberate-red copy adds exact child cleanup to avoid leaking another
server.

Archive searches for cleanup and port ownership found related process
discovery cases, including the September 4 kill-services pipefail case. None
explains this post-PASS shell-versus-child ownership failure.

Private evidence is under
`.context/acceptance/static-gate-followup-rca/`: `owned-orphan-cleanup.json`,
`launcher-orphan-red.json`, `run-port-ownership-red.log`, `run-port-green.log`
and `run-port-green-cleanup.json`. The repaired complete suite passes under
the same native Bash 3.2. Each of the three recorded listener PIDs is
independently absent after its EXIT cleanup.

## Solution

Use `exec` for each of the three HTTP server commands, so the recorded PID
becomes the listening process. Assert that each recorded PID actually owns its
TCP LISTEN socket after readiness. Existing readiness, collision, outbound
connection and port reassignment assertions remain intact.

Remove the pre-test sweep that killed any HTTP server in a port range. A port
range cannot establish fixture ownership, and sweeping it masked earlier leaks
while risking unrelated processes. The test now cleans up only its recorded
processes. No production service discovery or benchmark lifecycle changes.

## Human feedback

The user required exact owned-process cleanup and prohibited broad kills or
changes to production runtime behavior. Follow-up cleanup used the captured
native birth identities for the three proven fixture orphans only.

## Reusable lesson

Make fixture launchers exec the long-lived service and verify that the recorded PID owns its listener before relying on PID cleanup.
