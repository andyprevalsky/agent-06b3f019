---
id: 2026-11-06-relay-retire-guest-shipped-drain-agent-path-past-exec-bound
date: 2026-11-06
title: Relay bootstrap retirement always refused because its guest shipped the drain's unused normal-agent path past the 16 KiB exec bound
surface: infra
component: cloudbench-controller-relay-retire
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-controller-relay-retire.py GUEST = D["GUEST"] + RELAY inherited the orphan drain's full guest (pidfd shim + core + normal-agent AGENT path), so command() exceeded the 16384-byte Machine exec body bound once PR #1599 prefixed the pidfd shim
symptoms:
  - "ValueError: bounded relay retirement body required"
  - "test_process_uid_and_guest_command_are_bound"
  - "test_configured_snapshot_inventory_uses_current_donor_proof ValueError: substring not found"
tags:
  - cloudbench
  - relay
  - machine-exec
  - deploy-gate-registration
  - extraction-test
  - descend
sources:
  - PR #1599
  - commit 337c3f30f8
  - commit 2ee27805f0
repro: scripts/tests/cloudbench-controller-relay-retire.test.py::Relay::test_process_uid_and_guest_command_are_bound
status: fixed
---

## Problem

Two structural tests failed deterministically on `descend/epoch6-20261106`
(4bb4528efe), alone and unloaded, Linux, `TMPDIR=/var/tmp`:

1. `python3 scripts/tests/cloudbench-controller-relay-retire.test.py` →
   `test_process_uid_and_guest_command_are_bound`:
   `ValueError: bounded relay retirement body required` (0.4 s, 1 of 6).
   `local_state()` calls the same `command()`, so every `--check`, `--run`
   and `--observe` of the relay retirement operator refused before any
   provider call. Also red on `origin/main` (ccaf96cda8): body 16403 > 16384.
2. `pytest agents/benchmarks/cloudbench_campaign_inventory_test.py::test_configured_snapshot_inventory_uses_current_donor_proof`
   (all 9 cases) → `ValueError: substring not found` at
   `source.index('\nelse\n    # `|| echo', start)`. Green on `origin/main`.

## Diagnosis

Relay retirement: the exec body is `gzip+base64([GUEST, payload])` and must
stay within 16384 bytes. Measured at each mainline merge touching the guest
inputs: 15747 bytes through #1600 (562ed4080b), 16403 bytes from #1599
(88770cbd4e). Component sizes show the only growth was the drain guest gaining
`PIDFD_SOURCE` (1341 chars; 337c3f30f8, merged via #1599). The relay guest was
`D["GUEST"] + RELAY`, where the drain guest is `pidfd + core + AGENT`. `AGENT`
(19679 chars, the normal-agent capture path ending in `old_execute=execute`)
is never reached by the relay, whose own `execute` replaces it. The relay
needs only core names (`need`, `read`, `digest`, `obj`, `save`, `process`,
`prerequisites`, `ROSE_UID`, `PARENT_PID`) and the pidfd shim. Dead code had
been consuming 6.5 KB of compressed headroom until a legitimate core addition
crossed the bound.

The deeper cause is registration: the drain test is a deploy structural gate
(`cloudbench-controller-orphan-drain`), but the relay test, which consumes the
drain guest, was only in `scripts/test.sh`. #1599 changed the drain and
passed its gates while breaking the relay on main for nine days.

Inventory test: descend I-02 commit 2ee27805f0 moved the `|| echo '[]'`
comment out of the unpinned `else` branch into a new shared
`capture_warm_snapshot_inventory()` preamble. The test located the end of the
pinned branch by that comment text. `run-bench-fleet` behavior was unchanged;
only the extraction marker was stale (relative of
`2026-07-21-helper-moved-out-of-run-sh-broke-extraction-tests`). I-02 verified
its own new test, not the whole file.

## Solution

- `scripts/cloudbench-controller-orphan-drain.py` exports
  `CORE_GUEST = pidfd + core`; the drain's `GUEST = CORE_GUEST + AGENT` is
  byte-identical to before (verified).
- `scripts/cloudbench-controller-relay-retire.py` uses
  `GUEST = D["CORE_GUEST"] + RELAY`. Body: 16403 → 9351 bytes. The test's
  bound and round-trip assertions are unchanged.
- `scripts/run-deploy-structural-gates.py` registers
  `cloudbench-controller-relay-retire` next to the drain gate, so a drain
  guest change must also prove the relay body fits. `.claude/commands/deploy.md`
  Step 4s lists the same command, as `run-deploy-structural-gates.test.py`
  requires.
- The inventory test now ends the extracted block at the pinned branch's
  own column-0 `else` (anchored on `if [ -n "${CLOUDBENCH_SNAPSHOT_ID:-}" ]`),
  not comment text. The block now also includes the shared retried capture.
  Mutation check: routing the configured-inventory path through
  `capture_warm_snapshot_inventory` makes all 9 cases fail.

10k-agent behavior: operator-only tooling; no per-agent work changes. The
relay exec body shrinks by 43%.

## Human feedback

None recorded.

## Reusable lesson

When a guest program is built by concatenating another tool's guest source,
ship only the core it calls and register its bound test in the same deploy
gate as the source it inherits.
