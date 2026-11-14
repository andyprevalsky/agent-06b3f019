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
repro: python3 scripts/tests/cloudbench-runtime-evidence-collector.test.py (cases transfer-stall, transfer-persistent-reset, transfer-corrupt on both the inline run-bench-cloud collector and the recovery collector; driver-log-stall on the recovery collector)
status: fixed
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

## Human feedback

None recorded.

## Reusable lesson

Fail closed on integrity, not on delivery: when content is already proven by a hash and a
re-read manifest, retry its transient transport reads from byte zero within a bound, and
keep every integrity and protocol check fatal.
