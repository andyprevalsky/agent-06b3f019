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
  - cancelled campaign guests kept executing until their 7,200 s backstop
  - prod Supabase pooler EMAXCONN after a cancelled cloud benchmark campaign
  - "guest shutdown was not delivered; exact Machine ... is natively stopped"
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
  - native-stop
  - delivery-receipt
  - sigint-ignored
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
(now `test_guest_shutdown_child_confirmation_supervisor_forwards_termination_and_awaits_cleanup`,
first committed as `test_fleet_child_supervisor_forwards_termination_and_awaits_cleanup`)
exits 97 (`proxy-killed-before-runner-cleanup`) on `origin/main`.

## Solution

The fix landed in three rounds. An independent adversarial review of the first
round (APPROVE-WITH-CHANGES) found that its native-stop trigger mistook the
controller's own failed request for "never delivered", that INT never reached
the runner, and that the stop phase was unbounded. A second independent review
(APPROVE-WITH-CHANGES) found that a delivered guest with a retired proxy was
polled on a dead port for the full 30 s, that HTTP 409 was accepted as
delivery, that a pending TERM could lose the receipt, that the tree-teardown
helper could `wait` on a job Bash had lost, and that the group-signal harness
leaked a hung session-leader controller. The final design is below.

### Deliver the stop while its transport is alive

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
- Every forwarded cancellation reaches the runner and the residual group as
  **TERM**: a campaign's TERM, a terminal Ctrl-C's INT and a HUP alike. The
  runner is started from an asynchronous subshell of a non-interactive shell,
  so it and its proxies inherit SIGINT ignored and its `trap 'exit 130' INT`
  could never run; with the first round, a forwarded INT left the runner
  running for the full grace and then SIGKILLed it without its EXIT cleanup.
  The supervisor still reports the original signal's exit status. The leader
  wait uses a builtin `kill -0` every 0.1 s and a once-per-second `ps` zombie
  check instead of a `ps` fork every tick; a failed `ps` read no longer ends
  the grace early.
- `run-bench-cloud`'s poll sleep is interruptible (`sleep & wait`), so the
  runner's EXIT trap starts at once instead of after a deferred 15–20 s
  foreground sleep; `stop_on_exit` reaps that sleep.
- `stop_on_exit` absorbs a second HUP/INT/TERM (a `:` trap) instead of running
  the `exit` trap inside itself. Previously the supervisor's residual group TERM, or the
  controller's process-tree teardown, aborted the EXIT cleanup midway and
  skipped proxy retirement, port-lease release, viewer teardown and the exit
  status line. Child commands keep default dispositions, and every caller still
  bounds the cleanup with SIGKILL.

### Natively stop only a guest that no party delivered a stop to

- When the guest accepts the runner's `/shutdown` (HTTP 202 or 204 only), the
  runner publishes `guest-shutdown.requested` in its bench output before it
  waits for the cleanup acknowledgement, on both the EXIT-trap path and the
  execution-window (`TIMED_OUT`) path. The receipt binds the fleet run ID, the
  runner token (`<owner>-<index>`), the Machine ID, the bench and the HTTP
  status. It is written to an `O_EXCL` temporary file with mode 0600,
  fsynced and hard-linked into place, so it never replaces an existing
  receipt; the directory is fsynced. HTTP 409 is never delivery: the
  unchanged guest status server answers it when the run token or credential
  is unconfigured (nothing recorded) or when the driver PID does not own the
  run (the request is written but the executing benchmark is not signalled
  and runs to its backstop). The runner still keeps polling after a 409, as
  before, but records no receipt.
- `confirm_guest_shutdown` holds HUP/INT/TERM from the POST through receipt
  publication and replays a held signal immediately afterwards. On the
  execution-window path the runner sets `GUEST_SHUTDOWN_RESULT=1` before the
  call, so its EXIT trap never re-posts; a TERM pending while curl waited used
  to run `exit 143` after the guest's 202 but before the receipt existed.
- `cloudbench_confirm_guest_shutdowns --native-stop-undelivered` (controller
  EXIT cleanup only) classifies a failed controller request (no status proxy,
  transport failure or a non-accepting status) with that receipt:
  - **exact match** (regular file, bounded size, same run, owner token prefix,
    Machine, bench, and HTTP 202/204): the stop was delivered and the guest may
    still be draining. It is never stopped natively. It stays on the existing
    `/shutdown-health` poll only while its proxy still accepts connections; a
    missing port or a refused loopback connection (curl exit 7) means the
    runner retired the proxy after its own window, so nothing can acknowledge
    the guest any more and it goes straight to the existing retention path
    (`KEEP_CLONES`, `guest-cleanup-unconfirmed`, retained-started guest). The
    first round polled that dead port until the 30 s deadline: about 39 s of
    controller cleanup after the runner exited against main's 5.7 s, and a
    campaign's 30 s SIGKILL then cut off the retention writes.
  - **absent**: nothing was delivered (the original incident). The guest is
    natively stopped.
  - **foreign, symlinked, oversized, malformed or non-accepted (including
    409)**: logged as unusable and treated as undelivered, so the guest is
    natively stopped. The fail-safe direction is to stop a guest that may be
    executing; its volume and owner remain for the forensic original-volume
    archive.
  The controller's own POST follows the same rule: a 409 is undelivered under
  `--native-stop-undelivered`. Recovery callers do not pass the flag and keep
  their previous contract, including polling after a 409.
- Acknowledgement polls send `X-Cloudbench-Run-Token` (`<owner>-<index>`) and
  `X-Cloudbench-Machine-Id`, which the guest status server already verifies.
  Siblings share the barrier credential, so a reused local port can no longer
  credit another guest's 204.
- The native stop runs concurrently with the acknowledgement polling, under one
  deadline of `min(CLOUDBENCH_GUEST_NATIVE_STOP_SECONDS (20), remaining
  cleanup deadline)`, so neither phase starves the other. Every Machines API
  call goes through `fly_with_timeout` with a per-call budget
  (`CLOUDBENCH_GUEST_NATIVE_STOP_CALL_TIMEOUT`, 8 s, clamped to the remaining
  deadline); `machine_status_exact_read`, `machine_config_exact_read`,
  `registry_machine_details` and `machine_volume_id` gained an optional timeout
  argument for this.
  - Phase 1 proves exact ownership from this controller's immutable audit (as
    before) and the live name and single mounted volume, re-reads the delivery
    receipt (the runner may have published it after the controller's own
    request failed while its POST was still in flight; such a guest is not
    stopped), then sends the first stop request. It runs through a sliding window of
    `CLOUDBENCH_GUEST_NATIVE_STOP_CONCURRENCY` (16), so every stop request is
    sent before any verification polling and no batch waits for its slowest
    member.
  - Phase 2 polls each requested Machine once per second against the shared
    deadline. While it reads anything but `stopped` or `stopping` (including a
    429/5xx-rejected request that left it `started`), the stop is re-issued
    with 1 s and 2 s backoff, at most `CLOUDBENCH_GUEST_NATIVE_STOP_REQUEST_ATTEMPTS`
    (3) requests in total. Only requests actually sent are counted; a spent
    budget sends nothing and is not reported as a stop request.
  - Only `stopped` verifies. `created`, `suspended` or any other state is
    unresolved, matching recovery's started-or-stopped contract: the receipt
    records `verified: false`, the call fails and the log names the exact
    Machine for exact-owner recovery.
  - `guest-native-stop.json` records the run, owner token, bench, Machine,
    volume, ownership kind, `stop_requests`, `verified_state`, `verified`,
    `delivery_receipt` (`absent` or the unusable reason) and `destroyed: false`.
    Nothing is ever destroyed, and the owner, volume and quarantine are
    retained.
- Bash reports the status from before an EXIT trap for a bare `return` inside
  the trap. Controller cleanup is such a trap, so the bounded config read
  returns its status explicitly; the unit regression runs the native stop from
  an `exit 143` EXIT trap to keep that boundary covered.

### Tree teardown must never wait on a job Bash has lost

The group-signal cases also intermittently logged `Owned process root <pid>
was absent from the teardown snapshot` and `an owned aggregator/snapshot
process survived local teardown`, which fails the suite's final
teardown-survivor check. It reproduces on `a7a35124f`. The progress
aggregator and inventory snapshot loop are background jobs that die from the
same group signal. Inside the controller's EXIT trap, Bash 5.2.21 can leave
such a job marked Running: `wait` returns at once (status -1) and `jobs -pr`
keeps listing a PID that `/proc` no longer has. `cloudbench_terminate_tree_and_wait`
then treated it as an unaccounted live job and failed closed. A standalone
reproduction of that trap sequence against the real helper failed 13 of 160
iterations.

The helper also called `wait` on any listed root missing from its process
snapshot. For a root that is still alive, that `wait` blocks until the root
exits. Under INT the aggregator ignores the signal and keeps running, which
matches the hung controller the second review found: a group-INT case left a
session-leader controller and its aggregator running for about five hours.

The shared helper now classifies a root missing from the snapshot from the
kernel and never waits without positive evidence that the wait returns at
once. A root `/proc` no longer has is terminal, like one that exits between
the job sample and the snapshot (already accepted). A zombie is reaped at
once. A live root the snapshot cannot account for fails closed immediately,
without a signal or a `wait`. The round-two controller-only `kill -0`
pre-filter was removed in favour of this single mechanism. The helper lives in
`scripts/lib/cloudbench-env.sh`, which guests source, but no guest script calls
it; only the host-side controller, runner and inventory loop do.

Each group-signal case asserts that its own controller log carries neither
teardown message and that no fixture process from it survives. The harness
records every controller it starts in its own session (exact PID and birth)
and reaps it, and every fixture process naming its private TMP_ROOT, on any
exit, including a failed or timed-out case. A self-test proves the reaper
finds and stops a leaked, TERM-ignoring session leader.

### Scaling

Each fleet controller stops only its own guests, and the campaign signals
fleets independently, so cancelling N fleets is N concurrent bounded cleanups,
not a serial walk. Inside a fleet, delivery and polling cost O(1) wall-clock
per batch of 32 guests. Provider calls are exact per-guest reads and stops
(O(1) payload, never an app-wide inventory list), issued only for undelivered
guests (normally none), at most 16 guests at a time. Per undelivered guest the
bound is 2 identity reads, at most 3 stop requests and at most one bounded
status read per second until it verifies or the 20 s deadline: at most about
25 Machines API calls, typically 4–5. The first round had no deadline, a
single stop attempt and up to 30 polls, about 33 calls per guest. At 10k
undelivered guests, Fly's organization rate limit would throttle some stops;
each is retried within the deadline and otherwise fails closed with its owner
retained and the Machine named.

### Residual risk

- **Runtime evidence after a cancellation (review finding 5).** The runner now
  completes its own EXIT bookkeeping, but its runtime-evidence capture still
  needs its data-plane proxy. The controller's `CHILD_PIDS` process-tree
  teardown runs right after its own acknowledgement confirmation and kills
  those proxies, and the supervisor's 15 s (at most 20 s) grace bounds the
  capture anyway. A cancelled fleet therefore still ends with
  `runtime-evidence-unconfirmed` and a retained owner that needs
  `--recover-stale-owner`, as the group-TERM regression asserts. Joining the
  runners' capture before the tree teardown would compete with the campaign's
  30 s SIGKILL ceiling for the controller's own cleanup, so it was not made
  part of this fix.
- **Receipt window.** A runner killed with SIGKILL after the guest's 202 but
  before it publishes the receipt leaves no receipt. A catchable signal is
  held across that window, and phase 1 re-reads the receipt just before the
  first stop, but a SIGKILL or a failed publication (for example ENOSPC) still
  leads to a native stop of that draining guest, which then needs the forensic
  archive.
- **Delivered guest that never drains.** It is no longer stopped natively; it
  is bounded by the guest's own drain controls and stays retained and owned.
- **Not implemented.** Reconnecting a fresh exact-Machine status proxy and
  retrying `/shutdown` before the native stop (the review's optional
  suggestion) is not done; the native stop remains the first response to an
  undelivered guest.
- **Controller cleanup ceiling.** The acknowledgement poll keeps its existing
  30 s deadline for a guest whose proxy is still alive but never answers 204,
  so such a guest can still push controller cleanup past the campaign's 30 s
  SIGKILL. A delivered guest with a retired proxy no longer does. The native
  stop is started before that poll and fits inside it.

### Regression coverage

- **End-to-end scenario.** It runs in `cloudbench-multi-workstream.test.sh`,
  which is both a documented Step 4cb Linux-host command and one of
  `scripts/run-cloudbench-controller-gate`'s `DEFAULT_SUITES`.
- **Unit tests.** They are selected by the Step 4cb dependency-sync
  `pytest -k`, a documented Linux-host command that the Fly gate's
  `DEFAULT_SUITES` do not run. They are also selected by the
  `benchmark-live-results` gate in `scripts/run-deploy-structural-gates.py`,
  which is the registry path that always runs them.

- Scenario 2-group-term in `scripts/tests/cloudbench-multi-workstream.test.sh`
  (`CLOUDBENCH_TEST_GROUP_TERM_ONLY=1`; `CLOUDBENCH_TEST_GROUP_TERM_CASES`
  selects `term`, `int`, `undeliverable` or `slowdrain`) runs the real
  controller and runner against the fake provider:
  - a deliverable guest under process-group TERM and under INT: the runner
    itself delivers the stop and writes its receipt; there is no native stop;
  - an undeliverable guest (its runner sees the guest's own HTTP 503, the
    controller then sees HTTP 000, so neither delivered) whose first stop
    request is throttled with a 429: exactly two stop requests, verified
    stopped, receipt `stop_requests: 2`;
  - a slow drain: the execution window expires, the runner delivers (202) and
    retires its proxy, and the controller group is cancelled while the guest
    drains for 90 s. There must be no native stop, the drain must complete,
    the owner and quarantine must be retained, and controller cleanup must end
    within 20 s of the runner's exit (main about 6 s; the second round 32–39 s).
  Every case requires the Machine and volume to be present, no provider
  deletion, no teardown-failure message and no surviving fixture process.
- `agents/benchmarks/cloudbench_dependency_sync_test.py`, in the
  `guest_shutdown_child_confirmation` family:
  - the supervisor forwards TERM, INT and HUP as TERM, the proxy outlives the
    runner's trap, and the original status is reported;
  - bounded escalation;
  - the runner's exact receipt for 202/204, none after a 503, a 409 or over
    a foreign receipt, and one that survives a TERM pending during the POST;
  - controller classification across absent, delivered, 409 and unusable
    receipts and a controller-side 409, with no polling of a retired proxy
    and exact-identity headers on acknowledgement polls;
  - the native stop across `started`, a throttled first request,
    always-failing stops, `created`, `suspended`, a mismatched volume, a
    foreign name, a hung status read and a receipt that appears late, all from
    an EXIT trap, counting only requests actually sent;
  - the runner's EXIT cleanup completing despite a second TERM;
  - tree teardown that neither fails on a kernel-absent lost job nor waits on
    a live root missing from its snapshot.

Fail-before evidence on `a7a35124f`:

- **Slow drain:** `guest cleanup request failed (HTTP 000)` followed by `🛑 …
  guest shutdown was not delivered; exact Machine … is natively stopped`, so
  the test fails with "a guest whose stop was delivered and still draining was
  stopped natively".
- **Throttled undeliverable guest:** "did not verify stopped … (state=started)",
  so the test fails with "the guest kept executing its benchmark 45s after the
  controller group received TERM".
- **INT supervisor case:** exit 93, because the runner ignored INT and never
  ran its cleanup.
- **HUP supervisor case:** exit 97, because the runner received HUP instead of
  TERM.
- **Second TERM during the runner's EXIT cleanup:** the trap aborted before
  delivering the stop or retiring the proxy.
- **`created` and `suspended`:** reported as "natively created" or "natively
  suspended" with exit 0.
- **Hung status read:** the native stop is not bounded.

With the receipt fix but the INT forwarding reverted, the INT scenario fails
with "the runner did not deliver the guest stop itself after the group INT".

Fail-before evidence for the third round, on `fa0ae4ef5`:

- **Retired-proxy slow drain:** "controller cleanup took 32.1s after the runner
  exited (limit 20s)".
- **Delivered guest with a retired proxy:** the unit case polled the dead port
  until the deadline.
- **HTTP 409:** a 409 POST published a receipt; 409 receipts and controller-side
  409s were classified as delivered.
- **TERM during the POST:** exit 143 with no receipt.
- **Late receipt:** the guest was natively stopped.
- **Spent budget:** reported as a sent request (status 1, not 2).
- **Tree teardown:** a lost job made it return 1 ("absent from the teardown
  snapshot"), and a live root missing from the snapshot blocked it until the
  test timed out.

## Human feedback

None recorded from a human directly. The original request required keeping
exact ownership, evidence retention and fail-closed release unchanged; never
destroying on an unconfirmed path; never touching foreign Machines; and
signalling only owned processes.

The follow-up request that relayed the independent review required:

- native-stopping only a guest with no exact run-scoped delivery receipt;
- handling an absent or unreadable receipt fail-safe, so the original
  undelivered guest is still stopped;
- leaving a delivered, draining guest on the existing confirmation and
  retention paths;
- forwarding INT and HUP to the runner as TERM;
- bounding the native-stop phase, with a bounded, fail-closed retry for
  throttled stops;
- never reporting `created` or `suspended` as stopped;
- proving fail-before and pass-after for each.

The third request relayed the second independent review and required:

- leaving a delivered guest with a refused connection to retention at once,
  with a timing assertion near main's;
- counting only HTTP 202/204 as delivered;
- reaping every controller the group-signal test starts in its own session,
  and checking that no fixture process survives;
- keeping the receipt when a TERM arrives during the accepted POST;
- bounded, identity-checked waits in the shared teardown helper;
- the receipt, test-name, coverage-claim and identity-header nits.

## Reusable lesson

Deliver a cancellation's stop through its transport before tearing that transport down, record that delivery durably, and natively stop only an exactly owned remote worker that no party delivered a stop to.
