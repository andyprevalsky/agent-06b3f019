---
id: 2026-10-18-campaign-cancel-sigkill-cut-controller-guest-release
date: 2026-10-18
title: Campaign cancellation SIGKILLed each fleet controller 30 s after its group TERM, cutting the controller's own guest-release cleanup and leaving started Machines
surface: infra
component: cloudbench-campaign
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py terminate_owned_children sent os.killpg(SIGKILL) to every controller still running 30 s after the cancellation TERM, while run-bench-fleet's EXIT cleanup was still inside its own CLOUDBENCH_CHILD_TERM_SECONDS (30 s) guest-acknowledgement phase, before any native stop, destroy or retention write
symptoms:
  - "⚰️  controller received TERM (08:15:23)" as the last line of a cancelled fleet job log, with no teardown lines after it
  - campaign summary.json cancelled jobs with "controller_exit_code": 137
  - guest-shutdown.requested (http_status 202) present but no guest-shutdown.confirmed or guest-native-stop.json
  - cancelled sharded diagnostic left guest primaries and an autoscaled worker STARTED on Fly after the fleets exited
tags:
  - cloudbench
  - campaign-cancellation
  - sigkill
  - exit-trap
  - guest-shutdown
  - sharded-controllers
  - resource-leak
  - fly-io
sources:
  - commit 373585f80 (run source)
  - commit 9b22c8473 (fix base, feat/cloudbench-sharded-controllers)
  - fleet run 20261018-073828-18083 (shard-02, leaked polar-odysseys-407381583456)
  - fleet run 20261018-073841-20553 (shard-00, natively stopped polar-odysseys-c4b9782b4f76)
  - fleet run 20261018-073842-19329 (shard-01, leaked worker 840492c2640048)
repro: scripts/tests/descend-command.test.sh
status: fixed
---

## Problem

A 100-copy sharded diagnostic (4 disposable controllers x 25 one-task fleets,
source `373585f80`) released at 07:46:15Z on 2026-10-18 and was cancelled at
08:15:18Z. The chain was operator SIGTERM, coordinator SIGTERM to the four
runners, `request_term` to each controller's
`cloudbench-original600-supervisor.py`, supervisor SIGTERM to
`scripts/run-bench-campaign.py`, then the campaign's `terminate_owned_children`
(`os.killpg(SIGTERM)` per fleet process group). The supervisors forward TERM
only and join without a kill; they reported JOINED at about 08:16:01Z.

Shards 02 and 03 left 17 guest primaries STARTED after their fleets exited (10
and 7 copies, mostly `polar-odysseys-*`). Shard 01 left one autoscaled worker
(`840492c2640048`, `polar-bu-067`) started. Shards 00 and 01 had natively
stopped their cancelled primaries.

Evidence from the four controller archives:

| Shard | Campaign TERM to fleets | Runner `/shutdown` | Fleet output after TERM | Fleet end |
| --- | --- | --- | --- | --- |
| 02 | 08:15:23 | 202 receipt, 08:15:23 (10/10) | none | 137 at 08:15:53.36 |
| 03 | 08:15:22 | 202 receipt, 08:15:22-23 (7/7) | none | 137 at 08:15:53.04 |
| 00 | 08:15:22 | failed, HTTP 000 (14/14) | native stop, `guest-native-stop.json` 08:15:35; destroy retries | 137 at 08:15:53.06-.21 (one exit 1) |
| 01 | 08:15:19 | failed, HTTP 000 (7/8) | native stop; j0006 cut after primary evidence check at 08:15:31 | 137 at 08:15:50 |

Every cancelled job in every shard ended with exit 137 exactly 30 s after the
campaign's TERM. Shard 02/03 job logs (for example `r001-j0095.log`) end at
`⚰️  controller received TERM (08:15:23)`. Their runners finished with 143 at
08:15:40-41 (`benchmark-child.finished`). No `guest-shutdown.confirmed` or
`guest-native-stop.json` exists.

## Diagnosis

Critical path (cancellation to guest release):

```
campaign request_stop -> terminate_owned_children
  os.killpg(fleet_pgid, SIGTERM)                          run-bench-campaign.py
    fleet: trap TERM -> exit 143 -> EXIT cleanup()        run-bench-fleet
      terminate aggregator/snapshot trees (<=30 s)
      cloudbench_confirm_guest_shutdowns --native-stop-undelivered
        POST /shutdown -> pending -> poll /shutdown-health
        until SECONDS+CLOUDBENCH_CHILD_TERM_SECONDS (30 s), silently
      autoscaler/provisioner/runner joins (<=30 s each), evidence,
      retention or native stop, Machine/volume destroy
  sleep 30 s -> os.killpg(fleet_pgid, SIGKILL)            run-bench-campaign.py
```

1. **The cleanup started.** The TERM trap printed its line and exited 143,
   which runs `cleanup()`. That function ignores further HUP/INT/TERM and
   works through bounded phases. Only an uncatchable signal can stop it.
2. **Shards 02/03: SIGKILL arrived during the acknowledgement window.** Each
   runner delivered the authenticated stop (202, `guest-shutdown.requested`
   at 08:15:22-23), so the guest was draining. `cloudbench_confirm_guest_shutdowns`
   prints on every rejected controller POST. It printed nothing, so the
   controller's own POST through the still-live proxy was accepted, or the
   cleanup had not yet reached it. An accepted POST puts the guest on the
   silent `/shutdown-health` poll. That poll's deadline is the function start
   plus `CLOUDBENCH_CHILD_TERM_SECONDS` (30 s), which is later than TERM + 30 s.
   In either case, the campaign's SIGKILL at TERM + 30.0 s arrives before
   cleanup can leave that phase. Native stop, the unacknowledged-guest
   retention writes, the retained-idle billing stop and destroy never ran,
   and nothing was printed.
3. **Shards 00/01: the transport failure made them faster, not correct.** The
   runners' stop requests failed (HTTP 000), so the controller classified the
   guests as undelivered and natively stopped them within about 13 s, before
   the KILL. The same KILL still cut those cleanups short. Logs end
   mid-`volume destroy attempt 5/6`, and shard 01 j0006 never reached worker
   teardown, which left autoscaled worker `840492c2640048` started.
4. **Transport was not the cause.** The guests that leaked were the ones whose
   data plane worked. The WireGuard degradation fixed in `86f70dc78` explains
   the HTTP 000 on shards 00/01. That degradation can only lengthen the
   provider calls that a 30 s KILL then cuts.
5. **Why was the KILL possible (Step 5a).** Cancellation had two policies in
   one file. The e2e-cutoff branch (added in `3cf4aed97`) TERMs only the
   controller leader and says that its EXIT ownership path retains generous
   cleanup and that no short internal KILL deadline is added. The
   operator-signal branch kept the 30 s `killpg(SIGKILL)` from the first
   campaign commit (`b00fcbd78`, 2026-09-09). Since then the controller's
   cleanup has grown to a 30 s acknowledgement phase plus several other 30 s
   phases. The outer deadline was not derived from the inner budgets, and
   the inner phases alone exceed it. The 2026-10-12 relative
   (`group-term-killed-guest-shutdown-proxy-before-delivery`) had already seen
   "a campaign's 30 s SIGKILL then cut off the retention writes" and shortened
   one controller path to fit. The outer deadline remained.
6. **The next rung leaves this boundary.** The guest itself has no dead-man
   switch, which is a guest design change outside this evidence. The
   controller already owns a bounded native stop and retention path; it only
   has to be allowed to run.

Archive searches: `campaign SIGKILL controller cleanup cancelled exit 137
machines left started` and `terminate_owned_children 30 second KILL campaign
controller EXIT trap cut short`. Relative:
`2026-10-12-group-term-killed-guest-shutdown-proxy-before-delivery` (same
cancellation path, different first-bad boundary). This is not a recurrence of
its delivery bug: here the stop was delivered, and the kill escalation above
the controller is the defect.

Reproduction (owning campaign lifecycle suite; a real campaign process and a
real fake controller in its own session):

```
bash scripts/tests/descend-command.test.sh   # CAMPAIGN_LIFECYCLE_REGRESSIONS block
```

`test_cancel_joins_controller_cleanup_past_former_kill_deadline` is a fake
controller that mirrors run-bench-fleet. Its TERM trap exits 143 into an EXIT
cleanup that ignores further signals, spends `CLOUDBENCH_CHILD_TERM_SECONDS`
(30) + 2 s, then releases the guest. On `9b22c8473` (unchanged campaign code)
it failed with the production signature:

```
AssertionError: False is not true : campaign ended the controller (exit 137) before its owned EXIT cleanup released the guest
```

`test_stop_signals_once_and_joins_delayed_controller_cleanup` (in-process,
with a stepped clock) failed with `[SIGTERM, SIGKILL] != [SIGTERM]`. The test
it replaces (`test_stop_runs_one_bounded_teardown_before_delayed_reap`) already
errored on the branch tip (`'Namespace' object has no attribute
'stress_defaults'`): its hand-built `argparse.Namespace` had drifted from
`parse_args`. That test asserted the KILL escalation as expected behavior, so
it was a test of the defect. The replacement uses the real argument parser.

## Solution

`terminate_owned_children` now sends one TERM to each live controller's
process group and returns. The campaign's existing main loop and its
`finally` block join every controller, so each job records the controller's
real exit status, and the shared relay and inventory publisher stop only
after all controllers have exited. The SIGKILL escalation is deleted. Both
cancellation branches now share the contract the e2e cutoff and the original600
supervisor already followed: signal the exact owner, then join its owned
cleanup without a kill. A stale comment that promised the 30 s escalation was
corrected.

Verification: the same lifecycle block passes after the fix (4 tests, about
33 s). The full registered gate `bash scripts/tests/descend-command.test.sh`
(`run-deploy-structural-gates.py` gate `descend-command`, and `scripts/test.sh`)
passed five consecutive runs of about 80 s each. The campaign suites
`cloudbench-cleanup-ticket-campaign.test.py` (18) and
`cloudbench-original600-supervisor.test.py` (16) pass. The cancellation subset of
`agents/benchmarks/cloudbench_campaign_inventory_test.py` has the same two
failures before and after this change. Both are pre-existing on this branch
(for example, `start_shared_relay` runs `git rev-parse` in a non-git fixture
root) and unrelated to the kill escalation.

Golden references: Claude Code's MCP client escalates SIGINT, SIGTERM, then
SIGKILL with sub-second grace (`claude-code-src/src/services/mcp/client.ts:1428-1525`).
Codex's app-server daemon SIGKILLs an exact PID or group
(`codex-rs/app-server-daemon/src/backend/pid.rs:532`, `:562`). Both escalate
for local processes that own nothing remote, so a kill loses nothing. A fleet
controller here is the only party that can stop and destroy its billable
remote Machines, and its cleanup phases carry their own deadlines, so a
shorter outer KILL turns slow release into no release. The repo's own
precedent for remote-owning controllers is followed instead.

Siblings prevented: retention writes cut after an unacknowledged guest; the
retained-idle billing stop never reached; truncated volume/Machine destroy
(shards 00/01); autoscaled workers never torn down (shard 01). The same holds
for `finally`-path cancellation when the campaign itself fails.

Scale (10k agents): one TERM per controller, as before. Joining uses the
existing 0.1 s `poll()` loop over active controllers, which is O(active
controllers) and unchanged. The change adds no channels, locks or provider
calls. The campaign stays alive for longer, which is the controllers' own
cleanup time.

Risk: a controller whose cleanup never terminates now holds the campaign
open, with liveness heartbeats, instead of being killed. The operator can
still act on that exact controller by its recorded PID and birth. A KILL would
have leaked its resources silently.

## Human feedback

None recorded.

## Reusable lesson

Never SIGKILL a controller that owns remote resources on a deadline shorter than its own bounded cleanup; signal the exact owner once and join its EXIT path.
