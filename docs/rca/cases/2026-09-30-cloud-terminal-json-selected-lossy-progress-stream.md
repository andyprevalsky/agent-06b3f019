---
id: 2026-09-30-cloud-terminal-json-selected-lossy-progress-stream
date: 2026-09-30
title: Cloud terminal JSON was selected from a lossy progress stream despite a complete sealed capture
surface: infra
component: cloud-terminal-artifact-transport
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud selected boot RUN_JSON from marker-delimited log text instead of its already verified sealed runtime file
symptoms:
  - "Invalid control character at"
  - "Rejected stale or mismatched cloud benchmark artifact"
tags:
  - cloud-fleet
  - terminal-artifact
  - evidence
sources:
  - PR #1299
  - fleet run 20260930-135320-4167
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_boot_terminal_result_preserves_sealed_capture_when_stream_is_truncated
status: mitigated
---

## Problem

Proof74's unchanged `polar-bu-070` completed with an ordinary FAILED verdict
and guest shutdown acknowledgement, but its streamed terminal JSON was rejected.
The slice receives zero credit; recovery preserves the original artifacts.

## Diagnosis

The rejected stream is 33,553,020 bytes, SHA256
`b2dc4cf08cf65bbb2ac5789a5883e83489028ba6ea83a9d8ffd9d179e0bec3ac`.
Parsing fails at line 1738, column 12,331,621 inside a message string.
The separately collected sealed `run.json` is 46,640,273 bytes, SHA256
`55e38cb4aa7b43067d40ed87719aa3b5a93f129d8320c617e222da925507b051`,
and parses with the real FAILED verdict. Runtime collection already binds that
file to the exact run token, machine, byte count, hash and terminal manifest.
The first bad owned boundary is choosing the incomplete display transport after
successfully preserving the complete file, not the result validator.

Archive searches were `Invalid control character run.json` and
`truncated streamed result runtime capture`. The September 27 raw-runtime
collection case is related: it supplied the complete capture but did not remove
this second terminal source. The exact loss inside the upstream log transport
is not diagnosed here; terminal correctness must not depend on that transport.

## Solution

Delete the redundant progress-stream terminal source in ordinary boot runs.
Read the already verified sealed file, then run the unchanged task, mode,
provenance and ownership checks. The existing held-driver infrastructure fixture
keeps its marker path. Missing captured files fail closed; no benchmark outcome,
prompt, evaluator, query threshold or teardown criterion changes.

The permanent reproduction executes the actual selection and validation shell
block with a 13 MiB message string whose progress copy is truncated. Command:
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k boot_terminal_result_preserves_sealed_capture_when_stream_is_truncated`.
Before the fix: one failed, three passed; the failure is the same JSON control
character rejection, native exit 70. After the fix: all four pass unchanged,
including missing-capture, foreign-owner and foreign-task refusals. The recovered
task remains FAILED. The owning benchmark blackbox terminal-evidence gate now
explicitly selects these cases. The unchanged live cloud task and requested
ten-slice streak remain required before live qualification is claimed.

## Human feedback

Repair infrastructure and preserve real task failures. Do not change scoring or
accept partial, foreign or unsealed evidence to manufacture a valid slice.

## Reusable lesson

Select terminal artifacts from the complete owner-bound file already collected,
and keep the progress transport out of the terminal correctness contract.
