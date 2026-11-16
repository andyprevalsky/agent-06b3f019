---
id: 2026-11-14-sealed-runtime-evidence-transfer-failed-closed-on-one-socket-stall
date: 2026-11-14
title: One 6 s socket stall while downloading a PASSED guest's sealed runtime evidence failed the job closed (exit 70 → INFRA_ERROR) and stopped the whole deploy smoke
surface: harness
component: cloudbench-terminal-runtime-evidence-collector
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud cloudbench_collect_runtime_evidence (inline "<stdin>" collector, per-file sealed transfer loop `chunk = response.read(...)`; same loop in scripts/cloudbench-collect-runtime-evidence.py) — after the first sealed manifest, any transport error (here TimeoutError from the 6 s socket read timeout) propagated and exited the controller 70, although the bytes are immutable and proven by sha256 + final manifest re-read, and the pre-manifest phase of the same collector already treats the same transport errors as transient
symptoms:
  - "complete terminal runtime evidence could not be verified -- infrastructure failure"
  - "socket.py recv_into TimeoutError: timed out"
  - "HTTP Error 409: exact runtime is not sealed"
  - "INFRA STOP: 1/11 scheduled jobs are confirmed infrastructure failures"
tags:
  - cloudbench
  - deploy-smoke
  - runtime-evidence
  - infra-stop
  - status-proxy
  - transport-timeout
sources:
  - PR #2009 deploy smoke campaign deploy-0ce0cd032f77a126ce8823177091880044136d1e8bf45f6461bd7ecc469ce958, job r001-j0010 (browser-biometrics-webdecoy), fleet owner d270c87e672c4b4f8f6e0fd4cdb38608, Machine 8175d6a900e418, run 20261114-124343-1193817, failing source 3e59de84956ea8756719a0814834b641957f8169
  - commit 442f4b18bb (introduced the "once sealed, transfers fail closed" contract)
  - PR #2072 (merge commit a53c8d9e1950500a75261c9c9bcf764d47123824)
  - fleet run 20261116-041436-1080717 (recurrence, polar-odysseys-73c63095aeed, guest 8193d9b9964548, build 1da1a94f95)
  - fleet run 20261116-041436-1080699 (recurrence, polar-odysseys-156e2acc9536)
repro: python3 scripts/tests/cloudbench-runtime-evidence-collector.test.py (cases transfer-stall, transfer-persistent-reset, transfer-corrupt on both the inline run-bench-cloud collector and the recovery collector; driver-log-stall on the recovery collector)
status: open
---

## Problem

The PR #2009 deploy smoke (2026-11-14 12:43–12:59Z, devbox b98c8745) stopped with
`INFRA STOP: 1/11 scheduled jobs are confirmed infrastructure failures (>= 5%)`,
breached at r001-j0010, task `browser-biometrics-webdecoy`. The guest task itself PASSED
(133 s, $0.30), its driver exited rc=0, and its cleanup was acknowledged, so the guest
had sealed its runtime evidence. The controller's terminal collector then failed in
`fleet-child.log` (about lines 64–100):

```
File "<stdin>", line 136 ... http/client.py read ... socket.py recv_into
TimeoutError: timed out
❌ complete terminal runtime evidence could not be verified -- infrastructure failure
urllib.error.HTTPError: HTTP Error 409: exact runtime is not sealed
Original exit code: 70
```

The 409 comes from the diagnostic-only `cloudbench_collect_failed_runtime_evidence`
that runs after the primary failure. `/failed-runtime-evidence` answers 409 because this
guest's cleanup was *clean*. It is a consequence of the failure, not its cause. The campaign
cancellation then left 7 owned guests STARTED. Six were recovered with
`--recover-stale-owner`. Owner 5b75960d (Machine 8576794b025ed8, STOPPED) was rejected
with "run artifact is missing execution provenance" and was handled by the originating
deploy.

## Diagnosis

1. Extracting the heredoc of `cloudbench_collect_runtime_evidence` from the failing source
   (`git show 3e59de84956:scripts/run-bench-cloud`) puts `<stdin>` line 136 at
   `chunk = response.read(min(65536, remaining))`. That line is inside the per-file
   download loop, which runs only after `manifest()` returned 200. So the guest was
   sealed (driver exited, clean ACK) and the collector was streaming an immutable file
   body.
2. `request()` opens every read with `timeout=6`, so one gap of more than 6 s between
   received bytes through the controller's status proxy raises `TimeoutError` from
   `recv_into`.
3. The collector's contract (comment introduced in 442f4b18bb: "Once sealed, transfers and
   the final manifest comparison fail closed") retries `URLError`/`TimeoutError`/
   `ConnectionError` only before the first manifest. In the transfer phase the exception
   propagates, the bash caller prints "complete terminal runtime evidence could not be
   verified" and `exit 70`, the job is NORESULT → INFRA_ERROR, and 1/11 crosses the 5%
   campaign stop.
4. Why was this possible? Failing closed on transport conflates *integrity* with
   *delivery*. Integrity of the sealed bundle is already proven independently of the
   transport: `Content-Length` must equal the manifest byte count, every byte is
   sha256-checked against the manifest, and the manifest is re-read and compared at the
   end. A retried transport read of sealed bytes therefore cannot admit wrong evidence. Only
   HTTP statuses, short/oversized bodies and hash mismatches indicate a contract breach.
   The pre-manifest phase already encodes exactly that split; the transfer phase did not.
5. The recovery collector `scripts/cloudbench-collect-runtime-evidence.py` (used by
   `--recover-stale-owner`) has the byte-identical transfer loop and final manifest read,
   so it fails the same way.

Local repro (`scripts/tests/cloudbench-runtime-evidence-collector.test.py`,
`transfer-stall`): a real HTTP fixture sends headers and 4 bytes of a sealed file, then
holds the socket open. Pre-fix, the inline collector exits non-zero with the production
signature (`File "<stdin>", line 139` on main, which is line 136 of the failing source
plus three prestack lines; `http/client.py read` → `socket.py recv_into` →
`TimeoutError: timed out`). Post-fix, the identical command passes.

What was not determined: why the status-proxy byte stream paused for more than 6 s on
that guest. The controller ran 11 concurrent guests through flyctl proxies, and the
originating box's raw logs do not time individual reads. The fix logs each retried read
(file, attempt, exception) to stderr so a recurrence records which file stalled and how often.

Archive searches: `rca_archive.py search "complete terminal runtime evidence could not be
verified TimeoutError"` and `"runtime evidence transfer socket read timeout collector"`,
plus a grep of `docs/rca/cases/` for `runtime evidence`. Relatives:
`2026-09-27-boot-terminal-collection-omitted-raw-runtime-logs` introduced the sealed
collection. Its lesson (preserve complete owner-bound evidence, independent of cleanup
acknowledgement) is kept: nothing about what is required changes.
`2026-10-18-campaign-children-started-second-fly-agent-on-shared-wireguard-peer` is a
transport-degradation relative, but there was one Fly agent here, so it does not apply.
The Historical Benches descend thread saw the same "could not be verified … exit 70"
line on 2026-11-07 without a case. Novel case otherwise.

## Solution

Both collectors read sealed bytes through `sealed_read()`. That covers each sealed file
download, the final manifest re-read and, in the recovery collector, each `--driver-log`
range read. It retries `URLError` (not `HTTPError`), `TimeoutError` and `ConnectionError` up
to 3 attempts, with 1 s then 2 s backoff, and logs each retry with the file and the
exception. An early EOF mid-body (`response.read` returning `b""`) is now raised as a
`ConnectionError`, so it gets the same transport treatment.

- A sealed file retry restarts from byte zero: the partial file is unlinked, the digest
  reset, and the file reopened with `xb`.
- A driver-log retry resumes at the bytes already held. The guest's 4096-byte sha256 anchor
  and the log generation prove continuity, and a mismatch is an HTTP 409, which is never
  retried.

Still fatal at once: HTTP statuses, `Content-Length` mismatch, oversized bodies, hash
mismatch and a changed manifest. Unchanged: the whole-capture SIGALRM deadline, the pending
latch and owner binding, and the campaign 5% infra-stop threshold. A persistently broken
transport still fails, after 3 attempts and not at the 7200 s deadline.

An independent reviewer found the driver-log site, which had the same class of defect. It
is fixed here.

The regression adds four cases. `transfer-stall` is the exact symptom; it failed before the
fix with the production traceback and passes after. Two are negative controls:
`transfer-persistent-reset` must fail after exactly 3 attempts with the latch retained, and
`transfer-corrupt` must fail on the hash mismatch without a retry. Those three run against
both collectors. The fourth, `driver-log-stall`, stalls the second range of a two-range
driver log; it failed before the fix with `TimeoutError` and now asserts exact bytes. The
test is now registered as its own `deploy-structural-gates` Gate
(`cloudbench-runtime-evidence-collector`). Before this it ran only inside the
multi-workstream controller suite, which `select_affected_tests.py --lanes-for` could not
see.

Not changed: the diagnostic-only failed-cleanup collector still runs after any primary
failure and prints a guaranteed 409 when the guest's cleanup was clean. That is triage
noise, not a classification change.

10k-agent behavior: per-guest, controller-local, at most 2 extra reads per sealed read and
only on a transport fault. No shared state and no fan-in.

Shipped in PR #2072 (merged a53c8d9e19, 2026-11-14): deploy gates 16/16 PASS including smoke 11/11 with browser-biometrics-webdecoy PASS, production semantics PASS.

### Recurrence 2026-11-16 (bounded retry did not hold)

In the browser-perf baseline campaign (build 1da1a94f95, which includes the
3-attempt sealed-read retry), two long Odysseys tasks failed with
`sealed runtime evidence read logs/backend.log attempt 1/3 failed:
TimeoutError('timed out')` (x2 to x3). The run then ended `complete terminal
runtime evidence could not be verified -- infrastructure failure`. Every
attempt timed out in `getresponse()` waiting for the status line, so the
request was accepted but no response headers arrived within the 6 s socket
timeout.

The guest was not the cause. For 8193d9b9964548 between 04:51:30 and 04:57,
Fly metrics show 99% idle CPU, no steal or iowait, and 3.3 GB MemAvailable.
The controller-side path was unstable instead. The run's status proxy was
re-leased 23 times; the 156e2acc9536 run re-leased 32 times. After the driver
exited (04:50:28), the shared relay closed this guest's lease at 04:50:57,
04:51:47, 04:52:20, 04:52:41, 04:53:34, 04:54:10, 04:54:32 and 04:54:48.

Why so much traffic at task end: `scripts/cloudbench-run.sh` emits the whole
run.json between `::CLOUDBENCH-RESULT-BEGIN::` and `::CLOUDBENCH-RESULT-END::`
in bench.log (`cat "$CONTEXT_DIR/run.json"`). That made bench.log 55 MB
(73c63095aeed, 37 MB of it JSON lines) and 77 MB (156e2acc9536). The
controller streams bench.log in 256 KiB relay requests until the DONE token.
That took from 04:50:21 to 04:55:58 for 73c63095aeed and from 05:07:44 to
05:13:47 for 156e2acc9536. Collection then downloads run.json again
(54–77 MB) as sealed evidence. In boot-launch fleets the controller never
uses the inline copy: `run-bench-cloud` reads the terminal result from the
sealed `remote-logs/runtime-evidence/run.json`, and keeps the marker path only
for `cloudbench_skip_held_driver_teardown_race` (infra probe /
skip-autoscaler). The duplicated transfer is therefore pure relay load at each
long task's end. The concurrent campaign members do the same, which is the
likely saturation of the shared relay. That relay saturation is inferred from
lease churn on a healthy guest and is not yet reproduced. Status is reopened.

A second contributor, also on the controller side: a stale default flyctl agent
(pid 3239061, started 2026-11-15 16:53Z by an earlier fleet in another
worktree) still ran on the same `~/.fly` WireGuard peer as the baseline
campaign's agent. The campaign code already documents that two agents on one
peer stall both tunnels. The treatment campaign had its own `FLY_CONFIG_DIR`
and a single agent, and recorded 0 sealed-read timeouts against the baseline's
2. The experiment owner stopped the stale agent. Follow-up, not built: the
campaign's peer claim (`claim_home_wireguard_peer`) could refuse to start, or
warn, while a foreign `flyctl agent run` process uses the same config dir.

Fix (2026-11-16, branch andyprevalsky/cloudbench-bounded-result-line):
`run-bench-cloud` now sends `CLOUDBENCH_INLINE_RUN_RESULT=0` to boot-launch
members outside the held-driver paths (config env and the staged rb.sh). The
choice comes from one helper, `cloudbench_inline_run_result`. With that value,
`cloudbench-run.sh` writes `run_result: bytes=<n> sha256=<hex>` instead of the
run record. The controller still takes the terminal record from the sealed
`run.json`, which the sealed manifest hash already proves. The emitted
identity is not compared: a watchdog-cancelled run legitimately rewrites
run.json after the result block, and
`test_watchdog_collects_cancelled_artifact_after_bounded_shutdown` pins that.
Infra-probe, skip-autoscaler and SSH-launch paths keep the inline record, and
so does any guest without the variable. No timeout changed. Regression:
`agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_guest_result_streams_identity_not_the_run_record`
runs the real guest emitter with a 50 MB run.json. Before the fix it wrote
53,043,696 bytes into bench.log; after the fix it writes under 4 KiB, and the
controller block selects and verifies the sealed copy. The fake guest in
`scripts/tests/cloudbench-multi-workstream.test.sh` models the same protocol.

## Human feedback

None recorded.

## Reusable lesson

Fail closed on integrity, not on delivery: when content is already proven by a hash and a
re-read manifest, retry its transient transport reads from byte zero within a bound, and
keep every integrity and protocol check fatal.
