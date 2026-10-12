---
id: 2026-10-12-group-term-killed-guest-shutdown-proxy-before-delivery
date: 2026-10-12
title: Fleet cancellation by process-group TERM killed the guest-shutdown proxies before delivering the stop, so cancelled guests kept executing against the production pooler
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet terminate_fleet_runner_group signalled the runner's whole process group, killing the flyctl status proxies that the runner's EXIT trap and the controller's cloudbench_confirm_guest_shutdowns needed to POST the authenticated guest /shutdown; cleanup then retained the still-running guest with no native stop
symptoms:
  - "controller received TERM ... guest cleanup request failed (HTTP 000)"
  - "runtime evidence is incomplete; retaining original fleet volumes"
  - "retaining durable capacity reservation with the recoverable guest machines"
  - cancelled campaign guests kept executing until their 7,200 s backstop
  - prod Supabase pooler EMAXCONN after a cancelled cloud benchmark campaign
tags:
  - cloudbench
  - fleet-cancellation
  - process-group
  - signal-handling
  - flyctl-proxy
  - guest-shutdown
  - emaxconn
  - supavisor
  - fly-io
sources:
  - commit 7f9adaafa
  - commit a07d44ab5
  - memory:supavisor-client-attribution
  - memory:polar-50k3-native-controller
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

On 2026-10-11 at 22:19:29Z a campaign of 42 one-task fleets
(`scripts/run-bench-campaign.py` → `scripts/run-bench-fleet` → per-bench
`scripts/run-bench-cloud`, boot-mode guests) was cancelled by SIGTERM to the
exact campaign controller. Every fleet log showed:

```
⚰️  controller received TERM (22:19:29)
❌ [polar-bu-025] guest cleanup request failed (HTTP 000)
❌ primary runtime evidence remains incomplete: ...
❌ runtime evidence is incomplete; retaining original fleet volumes
⚠️  --keep-clones: retaining fleet ownership at .../cloudbench-fleet-ownership/<token>
⚠️  retaining durable capacity reservation with the recoverable guest machines
```

No guest received a shutdown. Each guest driver and its full stack, including
the backend's Fast Mode cache Prisma pool on the shared production Supabase
pooler, kept executing for about 70 more minutes until each benchmark's own
7,200 s backstop (23:17–23:28Z). The pooler's own `supavisor_logs` attributed
about 515 held clients to these guests, and the 1,000-client cap saturated
(EMAXCONN) at 23:27Z, breaking production. The 2026-10-11 00:11Z cancellation
showed the same family ("guests did not acknowledge browser/session cleanup").
The runtime was an older held tree (base `a07d44ab5`); the same mechanism is
unchanged on `origin/main` `7f9adaafa`, verified below.

## Diagnosis

Critical path (cancellation → guest stop):

```
SIGTERM → campaign request_stop → terminate_owned_children
  os.killpg(fleet_pgid, SIGTERM)                        run-bench-campaign.py:213
    ├─ fleet controller: trap TERM → exit 143 → EXIT cleanup()
    │    terminate aggregator/snapshot (≥1 s) → cloudbench_confirm_guest_shutdowns
    │    POST http://127.0.0.1:<status-proxy>/shutdown  run-bench-fleet:7699 (main)
    └─ run_fleet_child_supervised subshell (same group): trap TERM
         terminate_fleet_runner_group → kill -TERM -- -<runner_pgid>  run-bench-fleet:12718 (main)
           ├─ run-bench-cloud (runner, setsid leader): EXIT stop_on_exit → confirm_guest_shutdown
           └─ flyctl proxy status/backend (same runner group, cloudbench-env.sh:1345) → dies
```

1. **Where data first goes wrong.** The supervisor's forwarded signal is
   delivered to the runner's whole process group. The runner's data-plane
   proxies (`flyctl proxy … &` in `cloudbench_start_data_plane_proxy`) are
   members of that group, so they die at the same instant the runner starts its
   EXIT cleanup. The runner's own `confirm_guest_shutdown` then reports
   `guest cleanup request failed (HTTP 000)` (or `status proxy is not
   running`), and about a second later the controller's
   `cloudbench_confirm_guest_shutdowns` POSTs to the same dead port: HTTP 000.
   The controller's cleanup comment already assumed "the local status proxies
   are still alive here"; a group-delivered signal violates that ordering.
2. **Why it was possible (Step 5a).** Every cancellation source that signals the
   controller's process group, not only the campaign's `os.killpg`, reaches the
   per-bench supervisors: a terminal Ctrl-C (INT to the foreground group) and
   the detached `--wait` forwarder (`cloudbench_signal_tracked_group`). The
   supervisors convert that broadcast into an immediate teardown of the delivery
   channel. Nothing ordered "deliver the stop" before "tear down the proxy".
3. **Why the guest kept running (deepest owned cause).** When the guest stop
   could not be delivered, cleanup's only response was to retain ownership
   (`KEEP_CLONES=1`) and leave the exact guest Machine *started*. Fail-closed
   resource release had been implemented as fail-open execution: a guest with
   no delivered stop has no other way to learn of the cancellation and runs to
   its 7,200 s backstop while holding shared production connections.
4. The next "why" (the guest has no controller lease/dead-man switch) is a
   guest-side design change outside this evidence; the controller already owns
   an exact native stop, which is the required bounded backstop.

Problem class: cancellation tore down its own delivery channel before
delivering the stop; orphaned guests kept consuming shared production
resources. Archive searches: `guest cleanup request failed HTTP 000 controller
received TERM status proxy` and `cancelled fleet guests kept running orphaned
guest backstop EMAXCONN pooler saturated after cancellation`. Relatives:
`2026-07-15-bash-parent-does-not-forward-term-to-fleet-descendants` (signal did
not reach the fleet; here it reached it too broadly) and
`2026-09-11-failed-stability-proof-abandoned-retained-fleet` (retained owner
after an unreachable proxy). Novel cause; not a recurrence.

Local reproduction (fake-provider fleet harness, real controller/runner code):

```
CLOUDBENCH_TEST_GROUP_TERM_ONLY=1 TMPDIR=/var/tmp \
  bash scripts/tests/cloudbench-multi-workstream.test.sh
```

The scenario starts a real foreground `run-bench-fleet` as its own session
leader (exactly the campaign's `start_new_session=True`), waits until the fake
guest is executing its benchmark, then sends `kill -TERM -- -<pgid>` (exactly
`os.killpg`). On `origin/main` `7f9adaafa` it failed with the production log:

```
⚰️  controller received TERM (00:07:09)
❌ [bench-group-term] guest cleanup request failed (HTTP 000)
❌ primary runtime evidence remains incomplete: …/bench-group-term
❌ runtime evidence is incomplete; retaining original fleet volumes
⚠️  --keep-clones: retaining fleet ownership at …
⚠️  retaining durable capacity reservation with the recoverable guest machines
FAIL: bench-group-term: the guest kept executing its benchmark 45s after the controller group received TERM
```

The runner's `fleet-child.log` showed `❌ guest cleanup request failed (HTTP
000)` and the fake journal contained no `machine stop`. A mutation run with
only the native-stop backstop (leader-first delivery reverted) still logged
`guest cleanup request failed (HTTP 000)` and failed the delivery assertion,
proving the group signal is the first-bad boundary. The supervisor unit test
`test_fleet_child_supervisor_forwards_termination_and_awaits_cleanup` exits 97
(`proxy-killed-before-runner-cleanup`) on `origin/main`.

## Solution

- `terminate_fleet_runner_group` (scripts/run-bench-fleet) signals the runner
  process itself first and waits, within the unchanged grace, for its EXIT
  cleanup. Only then does it signal residual group members and escalate to
  SIGKILL; the existing group-absence proof and the 20 + 3 + 3 s bound inside
  the controller's 30 s ceiling are kept. The proxies therefore stay alive
  while both the runner and the controller deliver the authenticated
  `/shutdown`. This matches the reference harnesses: Claude Code signals the
  exact MCP child PID and escalates SIGINT → SIGTERM → SIGKILL
  (`claude-code-src/src/services/mcp/client.ts:1428-1525`); Codex terminates the
  exact app-server PID and reserves group signals for its updater
  (`codex-rs/app-server-daemon/src/backend/pid.rs:431-446`, `514-560`).
- `run-bench-cloud`'s poll sleep is interruptible (`sleep & wait`), so the
  runner's EXIT trap starts at once instead of after a deferred 15–20 s
  foreground sleep; `stop_on_exit` reaps that sleep.
- `cloudbench_confirm_guest_shutdowns --native-stop-undelivered` (controller
  EXIT cleanup only) natively stops every guest whose authenticated `/shutdown`
  was not delivered (no proxy, transport failure or a non-accepting status),
  immediately after the request phase and before waiting for siblings. It stops
  only an exact Machine proven by this controller's immutable audit (fresh
  `by-machine-id` + `fresh/<name>` owned, or a claimed pool record) whose live
  name and mounted volume still match, never destroys, verifies the native
  state and writes `guest-native-stop.json`. Ownership, the volume, the
  `guest-cleanup-unconfirmed` quarantine and the runtime-evidence latch remain
  for the existing exact-owner recovery. A child-published exact
  `guest-shutdown.confirmed` marker is accepted while polling, so a runner that
  retires its proxy after its own 204 cannot trigger a false native stop.
  Recovery callers keep their previous contract.
- Requests and health polls are issued concurrently (batches of 32) and native
  stops run 16 at a time, so a fleet-wide cancellation costs one bounded request
  rather than one timeout per guest.

Regression coverage (deploy Step 4cb and `scripts/test.sh` cloudbench lane):
scenario 2-group-term in `scripts/tests/cloudbench-multi-workstream.test.sh`
asserts, for a deliverable guest, `/shutdown` delivery (guest stopped 1.0 s after
the group TERM, no native stop) and, for an undeliverable guest, an exact native
stop (0.5 s) with a receipt. Both require the benchmark process to exit, a
nonzero controller exit, the retained registry and evidence latch, the Machine
and volume present, and no provider deletion. The supervisor unit test asserts
the proxy outlives the runner's trap.

Scaling: each fleet controller stops only its own guests; the campaign signals
fleets independently, so cancelling N fleets is N concurrent bounded cleanups,
not a serial walk. Inside a fleet, delivery and polling are O(1) wall-clock per
batch of 32 guests and provider calls are exact per-guest reads/stops
(O(1) payload, not an app-wide inventory list), issued only for undelivered
guests (normally none). At 10k undelivered guests the burst is roughly four
Machines API calls per guest and would be throttled by Fly's organization rate
limit; a throttled stop fails closed with the owner retained and is logged.

## Human feedback

None recorded. The request required keeping exact ownership, evidence
retention and fail-closed release unchanged; never destroying on an
unconfirmed path; never touching foreign Machines; and signalling only owned
processes.

## Reusable lesson

Deliver a cancellation's stop through its transport before tearing that transport down, and natively stop any exactly owned remote worker whose stop could not be delivered.
