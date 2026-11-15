---
id: 2026-11-14-shared-relay-backpressure-sendall-total-deadline-scaled-with-host-buffers
date: 2026-11-14
title: Shared-relay backpressure test spent its 8 s socket timeout as a whole-transfer sendall deadline on a payload sized to host buffers
surface: harness
component: cloudbench-shared-transport-integration
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/tests/cloudbench-shared-transport-integration.test.py test_backpressure_bounds_memory_and_keeps_control_responsive sender() — client.sendall(payload) under client.settimeout(8) treats 8 s as the deadline for the whole ~1 GiB transfer instead of a per-wait stall bound
symptoms:
  - "line 357, in test_backpressure_bounds_memory_and_keeps_control_responsive"
  - "block=client.recv(65536)"
  - "TimeoutError: timed out"
  - "FLAKY occurrence 3b413cb2a8a142df96b47f59afbcb9ee"
tags:
  - cloudbench-shared-relay
  - socket-timeout
  - sendall
  - backpressure
  - structural-gate-load
  - flaky-test
sources:
  - commit 269fa4b38f
  - commit daacc1627c
  - commit fe15de14ee
  - PR #1931
repro: scripts/tests/cloudbench-shared-transport-integration.test.py
status: fixed
---

## Problem

PR #1931's deploy-command-structural round 7 (Blacksmith 4-vCPU VM, 8 concurrent structural
suites, source 97e89d52f6) failed
`SharedRelay.test_backpressure_bounds_memory_and_keeps_control_responsive` with
`TimeoutError: timed out` at line 357 (`block=client.recv(65536)`), `FAILED (errors=1)`; the
single same-source rerun passed (FLAKY occurrence 3b413cb2a8a142df96b47f59afbcb9ee). PR #1931
changed no relay code. Its quarantine marker (daacc1627c) was dropped by that branch's main sync,
so main (fe15de14ee) ran the test unquarantined.

Local repro on current main, 8-vCPU devbox, the full structural registry
(`run-deploy-structural-gates.py --max-workers 8`) pinned with the test to CPUs 0-3, and
`net.ipv4.tcp_[rw]mem` max raised to model a large-buffer host:

- default buffers (4/6 MB): 0 failures in 32 runs.
- 64 MB: 1 failure in 24 runs (the run that overlapped a 128/256 MB window); otherwise 0.
- 256 MB (payload 1041 MiB): 0/15 exact failures, instrumented `sendall` 4.43–7.96 s of its 8 s.
- 384 MB (payload 1553 MiB), the exact command: FAIL 2/6 with the identical line-357 traceback;
  the instrumented copy failed 3/6, and every failure printed
  `SENDALL_SECONDS 8.00 ... errors [TimeoutError('timed out')]` while every pass printed < 8 s.

## Diagnosis

1. Commit 269fa4b38f sized the payload `16 MiB + 2 * kernel_socket_buffer_capacity()` so that a
   large-buffer host cannot absorb it in kernel buffers. The bytes therefore scale with the
   host's `tcp_[rw]mem`/`[rw]mem_max` (≈1–1.5 GiB at 256–384 MB maxima).
2. `client.settimeout(8)` also governs the sender thread's `client.sendall(payload)`. Since
   Python 3.5 a socket timeout bounds the total duration of `sendall`, not each wait. The 8 s
   therefore covered the blocked hold (0.2 s + RSS read + control `check`) plus the full relay
   round trip of the host-sized payload.
3. **First bad boundary:** `sender()`. With steady progress but > 8 s total, `sendall` raised
   `TimeoutError`, which went into `errors` unchecked, and the sender stopped.
4. The relay echoed what it had received; the reader at line 357 then waited its own 8 s
   per-call `recv` timeout for bytes that were never sent and raised `TimeoutError`, masking the
   sender's error.

Why possible: the payload became host-dependent while the liveness bound stayed a fixed
whole-transfer deadline, so on a large-buffer, oversubscribed runner the test became a relay
throughput benchmark. The relay itself delivered every byte with bounded buffering (an
independent reviewer's pump mimic reproduced the same signature: sender timeout at the
deadline, then recv timeout after 400–470 MB). The broker is not at fault.

Same-class site checked: `test_explicit_release_aborts_stalled_stream_and_removes_live_marker`
also uses `sendall` under a 5 s timeout, but its stream is blocked until release aborts it, so
no data moves; a total deadline and a per-wait deadline are identical there. Not changed.

## Solution

`send_with_stall_bound()` sends with `send()` in a loop, so the unchanged 8 s socket timeout
bounds each wait for progress, exactly as `recv(65536)` already does on the read side. The
reader now reports a sender failure before re-raising its own `TimeoutError`. The payload
formula, the 8 MiB broker RSS bound, the 2 s control bound, the "not finished after 0.2 s"
assertion and every timeout value are unchanged.

Regression in the owning suite (deploy-structural-gates lane):
`test_backpressure_sender_timeout_bounds_stalls_not_total_transfer_time` drives the helper over
a socketpair with a 1 s timeout. A reader draining 64 KiB every 25 ms takes > 1.5 s in total and
must pass (it fails with `sendall`). Negative control: a reader that stops after 4 reads must
still raise `TimeoutError` within 5 s.

Same 384 MB / 4-CPU structural-load condition after the fix: the exact command PASSED 34/34
(12 + 12 + 10). In the last batch the fixed command and the original logic were interleaved in one
load window: fixed 10/10 PASS, original 3/10 FAIL, every failure at `SENDALL_SECONDS 8.00`. The
regression pins the writer's `SO_SNDBUF` (a flakiness cross-review showed an AF_UNIX socketpair
otherwise follows `net.core.wmem_default`); it passes and the `sendall` variant fails at both the
default and a 16 MiB `wmem_default`, and it passed 5/5 consecutive runs. Test-only change; no
production or 10k-agent effect.

## Human feedback

None recorded.

## Reusable lesson

When a test sizes a socket payload to the host, bound its sender per wait with `send()` (or a stall check), never with `sendall()` under a fixed socket timeout, which Python spends on the whole transfer.
