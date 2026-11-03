---
id: 2026-10-28-status-readiness-cancelled-live-proxy
date: 2026-10-28
title: Status readiness cancelled live proxy initialization
surface: harness
component: cloudbench-data-plane-proxy
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_start_data_plane_proxy terminated a live status proxy after one unavailable lifecycle observation
symptoms:
  - "status proxy lifecycle HTTP 000 not accepted; restarting pid"
  - "status data-plane proxy did not become ready within 180s"
  - "primary runtime evidence remains incomplete"
  - "isolated stack failed before the start barrier"
tags:
  - cloudbench
  - data-plane-proxy
  - readiness
  - process-lifecycle
sources:
  - PR #1627
  - commit 7c4ff6fe4acfc3e7b8caf0e6262c1fd8158e87e9
  - fleet run 20261028-181310-2300577
repro: scripts/tests/cloudbench-status-readiness-observability.test.py NativeReadinessTests.test_initializing_tunnel_survives_unavailable_lifecycle
status: mitigated
---

## Problem

Hub request 20d71198-e055-4bb1-b238-81aa9c645106 launched nine cloud smoke tasks.
The fleet log records a proven warm snapshot/dependency match, successful volume
clones, and accepted configured Machine starts. Six task controllers then failed
at status-proxy startup before the start barrier; they never acquired primary
runtime evidence. The first observed failing boundary is the controller's status
transport, not the later evidence-verification error.

Evidence root (relative to the integration worktree):
`.context/hub-poller-runs/20d71198-e055-4bb1-b238-81aa9c645106/fleet/runs/20261028-181310-2300577/`.
In `chat-mode/cloudbench-status-proxy.log`, attempt 1 starts at 18:31:47, is killed
at 18:31:51 after HTTP 000, and prints a WireGuard validation request terminated
by signal. Other attempts print Fly GraphQL HTTP 503 and closed agent-socket
errors. All six failed tasks show the same repeated live-proxy cancellation.
`chat-mode/fleet-child.log` then exits with status 125 and cleanup unconfirmed;
`detached-20261028-181309-2299761.log` records the downstream evidence failure.

The three remaining task report cards have `per_task[].status: passed` and
`results.passed: 1`; absence of a top-level status is their existing schema, not
an unknown task outcome. The `snapshot upload failed` string is emitted by the
best-effort live snapshot loop at `scripts/run-bench-hub-poller:132`. Terminal
upload is a separate path. That warning cannot explain an earlier proxy failure.

## Diagnosis

Critical path: Hub dispatch -> warm snapshot -> volume clone -> configured
Machine start -> status proxy -> driver health -> start barrier -> task ->
primary evidence -> final verification -> terminal upload.

What: status proxy initialization repeatedly loses its process state.
Where: `cloudbench_start_data_plane_proxy` in `scripts/lib/cloudbench-env.sh`,
previously the unconditional termination following a rejected health response.
Why: one HTTP 000 observation was interpreted as a reason to terminate a live
proxy. Fly was still initializing WireGuard during several of those kills.
Replacing the process resets initialization; it cannot make progress across
readiness observations even though the total deadline allows more time.
Proof: the captured cancellation logs and the same owning-helper reproduction
on original and fixed source. The offline fixture retains real child process
ownership and a deterministic three-observation initialization protocol.
Problem: logical inconsistency in harness contracts; lifecycle readiness and
process liveness are independent states.

Archive searches: `status proxy lifecycle HTTP 000`, and
`cloudbench wireguard proxy startup incomplete evidence`. The September 9 case
`2026-09-09-status-proxy-launcher-pid-only-readiness` is related: it correctly
prevented PID-only false readiness but its terminate-on-rejection fix introduced
this cancellation failure. Its original false-readiness defect did not recur.

The permanent test was first observed failing with
`AssertionError: 1 != 0 : live tunnel initialization was repeatedly cancelled`.
After a repeated run exposed host-clock dependence in the new dead-child fixture,
the fixture was changed to a logical clock and exact child-start rendezvous,
then re-proven against original HEAD helper and fixed helper. Final artifacts:
`/var/tmp/deploy-1627/rca/cloud-smoke-final-before.log` and
`/var/tmp/deploy-1627/rca/cloud-smoke-final-after.log`.
Exact command on both source snapshots:
`READINESS_TEST_SOURCE=/var/tmp/deploy-1627/rca/cloud-smoke-source-under-test.sh python3 /home/boxes/rose/.claude/worktrees/agent-a0f677519b4ea0db3/scripts/tests/cloudbench-status-readiness-observability.test.py NativeReadinessTests.test_initializing_tunnel_survives_unavailable_lifecycle`.
The source-under-test copy was original HEAD before and the working helper after;
no test assertions changed between those final two runs.

## Solution

Delete the terminate-on-rejected-response behavior for a live status proxy.
Continue checking the same process within the existing readiness deadline.
Require the unchanged accepted lifecycle codes (204, 410, 425) before publication;
replace exited processes and terminate/reap the owned process on deadline.
Backend process readiness, lease collision handling, and shared transport are
unchanged. This removes the destructive transition rather than adding retries,
raising a timeout, or bypassing verification. The same fix permits both slow
WireGuard setup and delayed guest lifecycle service initialization.

Three native offline regressions cover initialization, exited-process replacement,
and rejected-response deadline/cleanup. They extend
`scripts/tests/cloudbench-status-readiness-observability.test.py`. The existing
cloudbench dependency suite invokes them from
`test_data_plane_proxies_retry_machine_dns_and_restart_if_lost_readiness_regressions`,
which matches the unchanged deploy cloudbench `-k` selection. The five focused
pytest cases passed, and the five-case readiness script passed five consecutive
runs with unchanged source. Syntax and diff checks passed.

Golden reference: not applicable (no approval-gated hunk).

Scope limitations: this proves the owned cancellation defect, not recovery from
Fly's independently observed HTTP 503 or the full cloud smoke outcome. No paid
fleet or live third-party call was launched. Guest behavior behind the failed
transport remains unobserved; the deploy owner uses the separately authorized
local smoke gate. For that reason the incident status is mitigated rather than
end-to-end fixed. The next fleet invocation loads the helper; no backend or
worker restart is required. Do not restart the existing poller/fleet.

The deploy coordinator owns landing this archive draft and reindexing, per the
RCA worker's ownership restriction. Global archive validation currently observes
another active worker's unfinished case; it must be repeated after integration.

## Human feedback

The user prohibited timeout increases, skips, weaker assertions, retries-as-fix,
and paid fleet runs unless a single-task proof was strictly necessary. The user
required an offline regression in the existing cloudbench deploy suite and
restricted this worker's file ownership. The coordinator assigned the shared
helper and retained ownership of archive integration. No additional correction
was requested.

## Reusable lesson

Preserve live transport initialization across unavailable service observations while keeping readiness acceptance, deadline failure, and exact process cleanup separate.
