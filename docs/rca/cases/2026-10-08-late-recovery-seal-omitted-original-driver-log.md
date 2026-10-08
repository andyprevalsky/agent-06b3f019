---
id: 2026-10-08-late-recovery-seal-omitted-original-driver-log
date: 2026-10-08
title: Late runtime recovery omitted the original driver log required by the archive
surface: infra
component: cloudbench-artifact-collection
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: the late fleet recovery standalone collector sealed runtime files without collecting the sibling original driver log required by the forensic archive
symptoms:
  - "FileNotFoundError"
  - "remote-logs/cloudbench-driver.log missing"
  - "sealed runtime evidence recaptured"
tags:
  - cloudbench
  - evidence
  - recovery
  - driver-log
sources:
  - fleet run 20261007-224256-41245
  - commit e4659614f177237c7083d5e23bc8621d2dfc3c2c
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_terminal_runtime_evidence_collects_complete_logs_recovery_driver
status: mitigated
---

## Problem

The ordinary exact-owner recovery collected a previously missing Doordash
runtime bundle from original C11. The subsequent standard interrupted-pool
archive builder failed at line 111 while opening that task's
`remote-logs/cloudbench-driver.log`. There were 49 sealed runtime bundles but
only 48 corresponding driver logs. All original task outcomes and C11's failed,
zero-credit qualification remain unchanged.

The actual failure log is retained privately under
`.context/completed-guest-recovery.private/original-exact-recovery-03/`
(`build-forensic-archive.private.log`, SHA256
`e646b0a3c3bab58e6dbe1062072d02163868f84789504647ba2130b0c9c5a0b5`).
The original task's 842-byte runtime manifest has SHA256
`32e125e3b15bfd73454ccca9d83fe6f1135a4fdbe39c532a7e1e033f45ac5c19`.

A separately authorized read-only exact-Machine capture recovered 22,153,275
original driver bytes, SHA256
`20546863ebfe53b1630686ca85e1f34d202980b6ef8142023b1dc7d5f9840b6f`.
Native checks before and after the ordinary SFTP read bound the exact run stamp,
owner/config/volume, exited driver and clean acknowledgement, stopped services,
and unchanged byte count and checksum. The actual bytes were published
atomically to the missing expected path; the original manifest and failed
partial archive were preserved. This handoff is recorded in the private
`doordash-original-driver-capture/publication.safe.json` receipt, SHA256
`2eb5c8662c115dadb4ceb3ff5c0fec363174b018b702a242c17d4822f5bb25aa`.
It proves recovery of that file, not complete resource release or benchmark PASS.

## Diagnosis

The path is original guest driver → bounded status data plane → late fleet
recovery's standalone collector → local driver/runtime artifacts → forensic
archive → normal resource reaper. `run-bench-cloud` ordinarily copies its
accumulated SSH log to the required driver path. An interruption can leave that
file absent or containing only an original prefix. Late recovery invokes
`cloudbench-collect-runtime-evidence.py` directly; that collector transferred
the sealed manifest's runtime files, whose inventory deliberately excludes
`bench.log`. It therefore could report a successful runtime recapture while
leaving the archive consumer's separate driver-file obligation unsatisfied.
The source held the missing bytes; neither a replacement task nor an invented
manifest was necessary.

Archive searches were `FileNotFoundError cloudbench-driver.log` and `recovery
runtime seal missing original driver log`. The September 27
`boot-terminal-collection-omitted-raw-runtime-logs` case is a relative: its first
bad boundary was normal boot collection omitting service logs while retaining
the driver. This incident is the separate late-recovery producer omitting the
driver while retaining service logs. The completed-primary recovery case
concerns admission of an already retired original, not this transfer obligation.

The permanent owning test runs the actual late-recovery transfer block, the
real loopback status server and the standalone collector. Its seven unchanged
controls cover an absent file, a complete existing file, an exact interrupted
prefix, a foreign existing stamp, a same-stamp nonprefix, a foreign guest stamp,
and a changed transport generation. The fixture supplies a FAILED task verdict;
collection leaves that verdict unchanged. It starts no DB, provider, model or task.

Exact command, from the root with the matching agents venv and modern Bash:

```bash
python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k boot_terminal_runtime_evidence_collects_complete_logs_recovery_driver -rA
```

On original `e4659614f177237c7083d5e23bc8621d2dfc3c2c`, the command exited 1:
six failed and one passed in 4.08 seconds, including the missing-driver assertion
`late recovery sealed runtime but omitted the required original driver log`.
The identical test bytes pass on the candidate: seven passed in 0.97 seconds.
Private source/test-bound RED and GREEN receipts and complete logs are under
`.context/recovery-driver-log.private/`. This proves the artifact mechanism;
no local benchmark replay or new LIVE outcome is claimed.

## Solution

Only the existing late-recovery invocation requests `--driver-log`. The default
standalone runtime-collection interface remains compatible. Driver capture uses
the existing authenticated exact-run/exact-Machine status endpoint, bounded
chunks, rolling suffix anchor, unchanged generation and size, exact first
RUNSTAMP, and terminal EOF. Its existing whole 600-second capture budget,
six-second transport reads and 512 MiB file bound are unchanged. There is no
new stage timer, retry, SSH fallback, task replay or acceptance exemption.

An absent file is published exclusively after complete capture and fsync. A
byte-identical complete existing file keeps its original inode and timestamps.
An exact original prefix keeps its inode and bytes in a new private directory,
durably linked before the complete actual capture atomically replaces the
expected path. A nonprefix, foreign identity, changed generation or unstable
capture is refused with existing evidence and pending ownership retained.
No diagnostic text is concatenated into driver evidence. Runtime publication
still requires the unchanged second manifest comparison. Only the existing
receipt consumer and reaper can change retention or release resources.

The test belongs to the existing controller regression family. The actual
normal deploy command, with only `--collect-only` added, selects all seven new
controls: 399 of 990 tests in 0.80 seconds, exit 0. The existing selector already
includes `boot_terminal_runtime_evidence_collects_complete_logs`; no new gate or
verification framework is added. The live original's final archive/reaper
outcome and a future production rollout are separate from this candidate proof,
so the case remains mitigated.

Golden references were inspected locally: Claude Code's
`claude-code-src/src/tasks/LocalShellTask/LocalShellTask.tsx:224` awaits
`flushAndCleanup` before terminal task state; its implementation at line 515
flushes output before cleanup. OpenClaw's
`openclaw/src/process/supervisor/supervisor.ts:283` fences all output paths
together when terminal settlement closes capture. Hermes's
`hermes-agent/tools/process_registry.py:1120` flushes the reader's decoder,
joins the child, then records exit. These put output capture and terminal finalization under the lifecycle owner;
none provides an exact Fly stopped-runtime recovery analog. The local
Codex snapshot was absent; it was not fetched during this bounded repair.

## Human feedback

The parent relayed the user's end-stage usability requirement: an interrupted
original prefix is an expected recoverable state, not a reason to reject
recovery forever. Preserve it privately and publish complete actual bytes;
foreign/nonprefix/unstable evidence must still fail. Keep the ordinary whole
budget, existing deploy wiring, original failed outcome and zero credit.
No original source, ledger, provider configuration, task or model may be altered
to manufacture a passing run.

## Reusable lesson

Make every recovery producer fulfill the complete original artifact contract before its archive consumer or reaper advances.
