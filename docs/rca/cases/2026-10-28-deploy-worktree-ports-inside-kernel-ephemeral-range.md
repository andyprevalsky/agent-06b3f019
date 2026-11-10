---
id: 2026-10-28-deploy-worktree-ports-inside-kernel-ephemeral-range
date: 2026-10-28
title: Deploy-worktree port registry allocated listen ports inside the kernel ephemeral range
surface: infra
component: deploy-worktree-ports
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy-worktree-port.py Registry.claim selected base ports from 56000 upward without excluding the live /proc/sys/net/ipv4/ip_local_port_range, so an owned listen port could be autobound by any outbound connection
symptoms:
  - "Error: listen EADDRINUSE: address already in use :::56022"
  - "Backend process exited before becoming ready"
  - coverage shard failed at startup with no listener on the port
  - "No available coverage port in this workspace's owned range"
tags:
  - ports
  - ephemeral-range
  - deploy-worktree
  - backend-coverage
  - eaddrinuse
  - regression
sources:
  - PR #1627
  - commit 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
repro: scripts/tests/deploy-worktree-preflight.test.sh
status: fixed
---

## Problem

Backend coverage shard 1 of the PR #1627 deploy (`back-end/coverage/shard-1.log`)
reserved port 56022 at 17:44:49Z (`.run-lock-shard1` mtime), booted under
20 s event-loop stalls, and died at 17:45:32.903Z with
`Error: listen EADDRINUSE: address already in use :::56022` from
`back-end/src/server.ts:605` (`app.listen`). Shard 2 bound 56024 normally.
Nothing was listening on 56022 before or after; the lane log shows no other
lane using 5602x. The worktree's base port 56000 came from
`scripts/prepare-deploy-worktree.sh` via `scripts/deploy-worktree-port.py`,
and `cat /proc/sys/net/ipv4/ip_local_port_range` on the host is `32768 60999`,
so every owned port (56000-56009 and the coverage shards at base+22/+24) lies
inside the window the kernel hands to outbound connections as source ports.
`reserve_coverage_port` in `back-end/scripts/run-coverage.sh` probed only
LISTEN sockets (`ss -ltn`) ~44 s before the backend bound.

The historical socket that held 56022 was not captured (no connection log);
the mechanism below is proven locally, offender attribution is not. A
not-excluded alternative holder: the concurrent deploy-command-structural lane
(17:44:47-17:54:31Z) runs the HEAD preflight suite, whose live claims bind
127.0.0.1:56020-56029 for an instant inside `_range_is_bindable`; the fixed
allocator moves those claims above the window too. Deploy run
20261028-174430-1609604 (backend-coverage-blackbox lane, shard 1 pid 1613956).
Related cases: 2026-10-18-inherited-isolated-port-bypassed-ephemeral-exclusion
(same window, isolated bench stacks) and
2026-09-30-reusable-bind-probe-mislabels-time-wait-port (probe socket options).

## Diagnosis

Critical path: deploy-worktree preparation → port registry claim (56000) →
`run-coverage-sharded.sh` derives shard 1 start = base+22 → `run-coverage.sh`
`port_in_use` (LISTEN scan says free) → reservation lock → 44 s of backend
startup → `app.listen(56022)` → EADDRINUSE.

Mechanism, executed locally (`/var/tmp/deploy-1627/rca/ephemeral-port-repro/bind_semantics.py`):
a connected, non-listening client socket on 58500 shows zero LISTEN rows, yet
`node -e "net.createServer().listen(58500)"` fails with EADDRINUSE; a bind
with or without SO_REUSEADDR fails the same way. A port our own SO_REUSEADDR
server left in TIME_WAIT is bindable by Node and by a SO_REUSEADDR probe, but
not by a probe without it.

Why 1: 56022 is inside the kernel autobind window, so an outbound connection
(or its TIME_WAIT remnant) can own it with no listener visible.
Why 2 (first bad boundary): `Registry.claim` never consulted the kernel
window; `agents/benchmarks/local.py` already excludes it for isolated bench
stacks (`_linux_ephemeral_port_range`), the deploy-worktree registry did not.
Why 3: the coverage reservation probe did not perform the bind Node performs,
so it could not notice the stolen port even at reservation time. A stop here:
the next rung (kernel autobind policy) is not ours.

Pre-fix proof: the registered suite run against a HEAD copy of `scripts/`
fails at `FAIL: a deploy worktree base port must lie above the kernel
ephemeral range 32768-60999 (got 56010)`; HEAD `run-coverage.sh
--print-coverage-port` with a connected client on 58700 prints 58700.
Post-fix: the same suite passes (46 PASS) and the probe prints 58701 while a
TIME_WAIT-only port (59701) stays eligible.

## Solution

- `scripts/deploy-worktree-port.py`: reads `ip_local_port_range` and
  `ip_local_reserved_ports` (fixture override `ROSE_DEPLOY_PROC_SYS_NET_IPV4`);
  new claims are only ranges wholly above the window (a host-only
  reservation does not survive reboot); no range above the window → fail
  with the kernel-window remedy (`sysctl -w net.ipv4.ip_local_port_range`),
  nothing published; an existing claim is accepted only above the window or
  with its 101-port footprint (owned ports, the +20/+22/+24 coverage shards
  and the +100 blackbox backend) reserved via `ip_local_reserved_ports`,
  otherwise claim fails
  closed and the live identity is not rewritten; a malformed, reversed or
  missing range fails closed on Linux and under a fixture tree; only a
  platform without the sysctl tree (macOS) applies no exclusion. New
  `check --base-port N` action.
- `scripts/prepare-deploy-worktree.sh --check` (deploy Step 0i gate) runs that
  check and fails loudly with the remedy.
- `back-end/scripts/run-coverage.sh` `port_in_use` first performs Node's own
  bind (dual-stack wildcard + SO_REUSEADDR), so a connected or client
  TIME_WAIT port is skipped while a reusable server TIME_WAIT port is not
  burned from the two-port shard range.
- Regressions: `scripts/tests/deploy-worktree-preflight.test.sh` (deploy
  structural gates registry) and the connected-socket / SO_REUSEADDR cases in
  `back-end/src/tests/unit/coverage-script.test.ts` (backend unit suite).

Siblings prevented: every listener a deploy worktree opens (backend, frontend,
worker metrics, Postgres, coverage shards, run.sh rescans) is no longer
stealable by autobind. 10k-agent behavior: per-host constant work at claim
time, no runtime path touched. Golden reference: not applicable (no
approval-gated hunk).

Follow-up risk: macOS publishes no `/proc` tree and its default ephemeral
range (49152-65535) covers 56000-64999 (`check` warns there instead of
passing silently); deploy worktrees are spaced ten ports apart while
coverage shards listen at base+22/+24 and the blackbox backend at base+100 of
a sibling's range (mitigated only by the shard reservation lock and probe);
the host `ip_local_reserved_ports` mitigation for the live 56000 worktree is
not reboot-persistent, so Step 0i fails after a restart until it is re-applied
or persisted in `/etc/sysctl.d`.

## Human feedback

The deploy owner required a durable, CLI-reproducible fix: allocate outside
the live range or reserve it with a preflight that fails loudly; no timeout
bumps, retries or benchmark changes; the live worktree keeps 56000 for this
deploy (host reserved 56000-56999). The Codex adversarial reviewer executed
five counterexamples that were adopted: new claims must ignore host-only
reservations, an unsafe existing claim must fail without rewriting the
config, malformed/reversed ranges must fail closed, and the +22/+24 coverage
offsets must clear the window.

## Reusable lesson

Allocate listen ports from above the live `ip_local_port_range` (never from
inside it) and probe availability with the exact socket options the listener
will use; a LISTEN-only scan cannot see a port an outbound connection owns.
