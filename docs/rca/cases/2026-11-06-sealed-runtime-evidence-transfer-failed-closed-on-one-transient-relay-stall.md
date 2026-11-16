---
id: 2026-11-06-sealed-runtime-evidence-transfer-failed-closed-on-one-transient-relay-stall
date: 2026-11-06
title: Sealed runtime evidence transfer failed closed on one transient 7 s relay tunnel stall and turned a passing task into INFRA
surface: infra
component: cloudbench-runtime-evidence-collector
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud cloudbench_collect_runtime_evidence (and its twin scripts/cloudbench-collect-runtime-evidence.py) treated a transport timeout during a sealed, hash-verified file read as a terminal integrity failure, so a single socket read stalled past urllib's 6 s budget ended collection with no restart even though the 7200 s whole-capture deadline had nearly all of its time left
symptoms:
  - "❌ complete terminal runtime evidence could not be verified -- infrastructure failure"
  - "TimeoutError: timed out"
  - "urllib.error.HTTPError: HTTP Error 409: exact runtime is not sealed"
  - "Original exit code: 70"
  - "no current run artifact produced"
tags:
  - cloudbench
  - runtime-evidence
  - shared-relay
  - fly-agent
  - transport-retry
  - false-infra
sources:
  - fleet run 20261106-181714-26175 (descend-failed-neverrun-20261106 batch 2 epoch 2, r003-j0057 browser-hotel-booking r3, Machine 784ee112c417e8, controller source f33a2df67e)
  - agent ec9ab8ac-4f94-42e2-8eb3-947e6e3483f5
  - fleet run 20261106-181714-26175 relay Fly agent log ~/.fly/agent-logs/1724196139.log (18:45:22.68-18:45:29.88 UTC)
  - commit ce99dc9bae (descend/epoch12-20261106 red source; fix on branch rca/i-15-20261106)
repro: python3 scripts/tests/cloudbench-runtime-evidence-collector.test.py (transitions file-stall, file-truncate, file-corrupt; parametrized in agents/benchmarks/cloudbench_runtime_retention_test.py::test_runtime_collector_rechecks_terminal_seal_and_bounds_transport_reads)
status: fixed
---

## Problem

In `/descend` run `descend-failed-neverrun-20261106`, batch 2 epoch 2, job r003-j0057 (`browser-hotel-booking` r3, attempt 1) was the first infrastructure failure (1/57). The task passed on the guest in 596.9 s, and the Hub outcome was acknowledged at 18:39. The guest driver printed `driver exited rc=0; holding for controller collection` at 18:41:34. The controller-side terminal collection then failed:

- 18:45:12–18:45:21: `cloudbench_collect_runtime_evidence` copied the cleanup status, `guest-diagnostics.jsonl`, `logs/backend.log` (3.0 MB) and `logs/worker.log` (28.6 MB, about 6.5 MB/s). It then started `run.json` (63,654,896 bytes). The partial copy `.runtime-evidence-wf6bio4f/run.json` last grew at 18:45:21.87, reaching 6,225,920 bytes.
- About 6 s later, `response.read` raised `TimeoutError: timed out` (`<stdin>` line 136, `http/client.py` line 473). The collector has no retry once the manifest is sealed. The runner printed `complete terminal runtime evidence could not be verified -- infrastructure failure`.
- The diagnostic failed-cleanup collector then received `HTTP Error 409: exact runtime is not sealed`. That 409 is correct: the guest's cleanup was clean, so `/failed-runtime-evidence` must refuse. The runner exited 70, and the report card shows `no current run artifact produced`.
- In the EXIT trap, `confirm_guest_shutdown` ran at 18:45:34 and the trap called the same collector again. It copied a complete, size- and hash-matching bundle to `remote-logs/runtime-evidence/` in about 11 s (run.json finished at 18:45:44.56). By design, the trap keeps the original exit status and the `runtime-evidence.pending` latch, because result validation, not a signal handler, decides acceptance. The verdict therefore stayed INFRA (`Original exit code: 70`).

## Diagnosis

Critical path: run-bench-cloud collector → `127.0.0.1:8795` shared relay lease (`cloudbench-shared-relay.py`) → the campaign's Fly agent socket → WireGuard tunnel → guest status server `:8011` `/runtime-evidence?file=run.json`.

1. **The stall was on the shared tunnel, not on the guest or this stream.** The relay agent log (`1724196139.log`) shows the run.json request as connection `#16925` (connect 18:45:20.62, `ok` at 20.71, dropped 29.88). New CONNECTs from 18:45:22.69 to 22.74 went to three different guests (`…34b:af36:f025:2`, `…252:5ab1:3f72:2` and `…207:6ad:4ed7:2`). All of them waited 7.14–7.20 s and received `ok` within the same millisecond, 18:45:29.881–29.882. The agent was also late reading local requests: `#16931` was accepted at 26.689, but its CONNECT line was not logged until 29.867. So the whole agent/tunnel stalled for about 7 s. The load did not explain it: 195 connects/min in that minute, compared with 600–1,100/min earlier in the campaign with no stall. No other runtime evidence copy ran at the same time. This was the only run with collection activity between 18:44:50 and 18:46. Similar single-episode stalls appear at 18:28:48–18:29:57 and 18:36:47 (3.09 s). The default `~/.fly` agent (PID 3606817, since 14:25) had established a tunnel at 14:45 but carried no connects after 14:45:53. This is not the sustained second-agent degradation in `2026-10-18-campaign-children-started-second-fly-agent-on-shared-wireguard-peer`. The tunnel's own cause (for example a WireGuard handshake retry) is inside flyctl and was not logged. That remains a third-party observability gap.
2. **Our first-bad boundary is the collector contract.** After the manifest is sealed, every file is immutable and served afresh for each request (`_serve_recovery_evidence` opens, fstat-checks and streams it). Each file's size and SHA-256 are already bound by the manifest, and the final manifest is compared again. A transport fault therefore cannot corrupt accepted evidence, and restarting the exact read is safe. The collector's comment ("Once sealed, transfers and the final manifest comparison fail closed") nevertheless handled a socket timeout, reset or truncated stream the same way as an HTTP rejection or hash mismatch. One stall of more than 6 s became a terminal INFRA, with about 7,190 s of the whole-capture alarm still unused. The same applies to the final manifest re-read, as in the 10-18 case's j0003 (`getresponse` timeout).
3. **Why the later complete copy did not count.** The main body had already decided `exit 70` before the EXIT trap re-collected. The trap's collection only preserves evidence for ownership/retirement, and the pending latch is released only after result validation in the main body. This ordering is the intended contract, so it is not changed. The fix makes the main-body collection succeed instead.
4. **Why run.json is 63.6 MB (noted, not changed).** `tasks[0].logs` (31.3 MB) is duplicated verbatim in `tasks[0].owned_roots[0].logs` (31.3 MB). Within it, `worker_logs` has 33,010 lines (30.4 MB): `llm.context.dumped` takes 9.4 MB in only 39 lines (gzip+base64 LLM payload dumps), `span.start`/`span.end` 12.7 MB, `realtime.broadcast_enqueue` 3.9 MB, and network body capture 1.8 MB. A larger file spends longer in flight, so a tunnel stall is more likely to land inside it.

Step 5a ladder: Why 1: the read timed out because the tunnel stalled for about 7 s. Why 2: the collector treated a transient transport fault on an immutable, hash-bound file as terminal. Why 3: the post-seal contract did not separate transport faults (retryable within the unchanged deadline) from integrity and protocol failures (terminal). Why 4 would be the Fly agent tunnel stall itself, which is third-party and unlogged. Stop at Why 3.

Archive searches: `complete terminal runtime evidence could not be verified infrastructure failure TimeoutError timed out` and `runtime evidence transfer read timeout relay stall large run.json false infra passing task`. The closest relative is `2026-10-18-campaign-children-started-second-fly-agent-on-shared-wireguard-peer`, which has the same symptom string but a different boundary: sustained degradation from a second agent session. Here there was one transient stall and no active second agent. This is a relative, not a recurrence.

## Solution

Both collector copies, the inline `cloudbench_collect_runtime_evidence` in `scripts/run-bench-cloud` and the fleet recovery helper `scripts/cloudbench-collect-runtime-evidence.py`, now wrap every post-seal read in `sealed_read_attempts`. That covers each file transfer and the final manifest comparison. A transport fault restarts the exact read from byte 0 on a new request, after deleting the partial file and resetting the digest. The faults covered are `TimeoutError`, `ConnectionError` (including a new `TruncatedTransfer` for a stream that ends before its Content-Length) and non-HTTP `URLError`/`IncompleteRead`. A file is attempted at most 3 times, inside the unchanged whole-capture alarm, with the unchanged 6 s per-read socket budget. Each retry prints `⚠️  retrying runtime evidence file <name> from byte 0 after a transport fault (attempt n/3)` to stderr, so tunnel degradation stays visible in `fleet-child.log`. These stay terminal on the first attempt: `HTTPError`, a status or Content-Length that disagrees with the manifest, an oversized response, a hash mismatch, a changed final manifest and the deadline alarm. No bound was raised.

The regression is in the owning fixture `scripts/tests/cloudbench-runtime-evidence-collector.test.py`, which runs both collectors concurrently against a real HTTP fixture:
- `file-stall`: the first run.json response sends headers and 100 KB, then stalls for 6.5 s. Both collectors must publish the exact bytes after a second request and print the retry line, with no partial directory left behind.
- `file-truncate`: every response closes early. Both collectors must fail after exactly 3 requests, publish nothing and keep the pending latch.
- `file-corrupt`: the bytes are wrong but the length is correct. Both collectors must fail with `runtime evidence hash mismatch` after exactly 1 request.

These transitions are parametrized in `agents/benchmarks/cloudbench_runtime_retention_test.py` (agents coverage). The fixture also runs from `scripts/tests/cloudbench-multi-workstream.test.sh` (deploy "Cloud Benchmark Multi-Workstream").

Red (source ce99dc9bae): `file-stall` failed with the production traceback (`<stdin>` line 136 → `http/client.py` line 473 → `TimeoutError: timed out`). `file-truncate` failed with `{'services.json': 1, 'run.json': 1}`, a single attempt. `file-corrupt` passed (control). Green: all three pass, 5/5 consecutive runs (7.8 s each). The full fixture passes (24 s), as do `cloudbench_runtime_retention_test.py` (75 passed), `cloudbench-prelaunch-cancel.test.py` and `cloudbench-preterminal-infra-release.test.py`.

10k-agent behavior: a retry adds at most 2 extra requests for one file per affected job, and only after a transport fault. There is no new process, socket, lease or polling loop.

Limits: outcome proof (an exact cloud rerun of r003-j0057 that collects through a tunnel stall) is pending the parent. The Fly agent's tunnel-wide stall remains an unlogged third-party behavior. The run.json duplication (`owned_roots[].logs` duplicating `logs`) is noted and was not changed.

## Human feedback

None recorded. The /descend coordinator assigned the repair as an infra fix that needs no approval. It asked for retry/resume within the existing deadline, no weakening of the integrity checks, and recognition of a later successful copy only if that is the intended contract. It is not: the EXIT-trap copy is evidence-preserving by design, so the main-body collection was made resilient instead.

## Reusable lesson

After a guest seals immutable, hash-bound evidence, retry transport faults on each read from byte 0 within the existing deadline and keep only HTTP, size, hash and manifest failures terminal, so a seconds-long tunnel stall cannot turn a passing task into INFRA.
