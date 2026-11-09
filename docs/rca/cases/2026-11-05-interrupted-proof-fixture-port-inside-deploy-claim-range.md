---
id: 2026-11-05-interrupted-proof-fixture-port-inside-deploy-claim-range
date: 2026-11-05
title: Interrupted-worker proof fixture hard-coded a root port inside the deploy-worktree claim range
surface: infra
component: deploy-test-cycle
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery.setUp bound the interrupted gate to the unclaimed CONDUCTOR_PORT 15000, whose LISTENER_OFFSETS footprint the deploy-worktree allocator can hand to a concurrently running gate
symptoms:
  - "ValueError: local cleanup: interrupted root listener remains"
  - deploy-command-structural failed suite deploy-test-cycle with 5 errors in InterruptedLocalRecovery
  - deploy-test-cycle passes in isolation but fails while other deploy gates run concurrently
  - FAILED (errors=5) InterruptedLocalRecovery
tags:
  - deploy-gates
  - port-collision
  - test-fixture
  - concurrent-gates
  - listener-footprint
  - deploy-worktree-port
sources:
  - plan:/var/tmp/rose-deploy-measure-evidence/summary.txt
  - plan:/var/tmp/rose-deploy-measure-evidence/attempt2/state/cycle.json
  - plan:/var/tmp/rose-deploy-measure-evidence/port-claims.txt
  - commit b80d31db5
repro: scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery.test_root_footprint_shares_no_port_with_any_claimable_deploy_worktree
status: fixed
---

## Problem

During a measured all-gates-at-once deploy run (12 local isolated workers, branch
`deploy-v2-rewrite`), the `deploy-command-structural` gate failed only the
`deploy-test-cycle` suite: all five `InterruptedLocalRecovery` tests raised
`ValueError: local cleanup: interrupted root listener remains` from
`deploy_test_local_cleanup.interrupted_worker`. The suite passes in isolation.
The structural gate ran 12:16:02-12:38:26Z and `deploy-test-cycle` finished at
+945.8 s (about 12:31:48Z). The `semantic-stack` worker held claim base 15100,
was STACK_READY at 12:21:45Z and ran until about 12:45Z.

## Diagnosis

`interrupted_worker` proves closure by reading host-wide LISTEN rows in
`/proc/net/tcp{,6}` for `CONDUCTOR_PORT + LISTENER_OFFSETS` (0-9, 20-29, 100,
200-209 and 5764-6264). The fixture hard-coded `CONDUCTOR_PORT=15000`, so its
footprint contained 15100, 15200 and 20764-21264. The branch allocator, now
starting at `FIRST_BASE_PORT=10000` and spacing footprint-disjoint claims about
510 apart, handed the eleventh claim base 15100 to `semantic-stack`. That
worker's listener on 15100, which is the fixture's +100 offset, made the
proof refuse. Production is scoped correctly: a real gate's port is a live
claim that `deploy-worktree-port.py` keeps disjoint from all other claims, and
`deploy_test_isolation.validate` checks it. The fixture used a port it had
never claimed, inside the range the allocator gives out. On `origin/main` the
same defect existed but could not be reached at this width: the allocator
started at 20000 in steps of 10, and 14 claims (20000-20130) never touch the
15000 footprint. Replaying both allocators into temporary registries gave the
exact measured sequence on the branch (10000, 10510, ... 15100, 21370, 21880,
22390), and claims 14590 and 15100 overlapped the fixture. Main had no overlap.

The local repro held listeners on 127.0.0.1:15100/15101/15200 while running
`python3 scripts/tests/deploy-test-cycle.test.py InterruptedLocalRecovery`. It
produced the same five errors. Holding only 15101, which is outside the
fixture footprint, passed. That rules out cwd/root matching and timing.

## Solution

The fixture now selects its root base with `interrupted_root_port()`. It picks
the lowest base whose whole LISTENER_OFFSETS footprint ends below the
allocator's `FIRST_BASE_PORT`, so no deploy-worktree claim can share it, and
which has no current listener (the same `/proc` predicate the proof uses) and a
bindable base. The live-listener refusal subtest binds that chosen base instead
of 15000. The production cleanup assertion is unchanged. The new regression
`test_root_footprint_shares_no_port_with_any_claimable_deploy_worktree`
computes the fixture footprint against every base the allocator can claim. It
fails on the hard-coded 15000 even with no foreign listener, and passes after
the fix. It runs in the registered `deploy-test-cycle` structural suite. The
helper also fails loudly if `FIRST_BASE_PORT` ever drops so far that no
unclaimable footprint remains. This adds no runtime or per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

A test that asserts host-global listener absence must bind its fixture to ports that no concurrently running deploy claim can hold, never to a hard-coded port inside the allocator's range.

## Concurrent occurrence: cloudbench fixture listener on 21136 (2026-11-07, PR #1760)

The PR #1760 staged deploy cycle ran on a branch cut before this fix reached main
(base 3e770c9e1, fixture still at 15000). Its `deploy-command-structural` gate failed
`deploy-test-cycle` with five `ValueError: local cleanup: interrupted root listener
remains`. That time the listener was not a deploy claim. It was the concurrent
`cloudbench-controller` gate's multi-workstream fixture, which held 127.0.0.1:21136 and
:21137 for 12 minutes, inside the 15000 footprint's Hub search range (20764-21264).
A network-namespace A/B on the unchanged source passed with no listener and failed
(errors=5) with one listener on 21136. PR #1760 briefly carried its own fix (holding a
bound, non-listening socket on every footprint port). It took this case's
fix at merge, because a footprint below FIRST_BASE_PORT also excludes that fixture's port.
