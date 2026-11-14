---
id: 2026-11-11-fake-driver-omitted-primary-ready-file
date: 2026-11-11
title: Fake driver omitted primary ready-file publication and HTTP serving
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_fake_driver emitted the readiness log without its native ready file and ProxyHandler returned404 for the primary ready URL
symptoms:
  - actual fake driver omitted primary ready marker
  - exact primary ready URL not served by native handler
  - cloudbench-multi-workstream.test.sh 0/5 1200s
  - PASS: scenario 6
tags:
  - fixture
  - readiness
  - http
  - deploy
sources:
  - PR #1881
  - commit 0bfc5c0f021c6b5d2bfef079a26ba7a86ac24380
  - task GitHub Actions 42931323824
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: open
---

## Problem

The current source's loaded whole-unit attempt timed out at1200 seconds with0/5 and last recorded scenario6 PASS. Aggregate occurrence e3fed196fe474f8abb83695063ae3b85 remains UNVERIFIED/complete=false; no inner failed assertion was recorded. A separate normal controller run passed in1254.083 seconds. Neither fact proves this fixture mismatch caused the entire timeout.

During the authorized isolated scenario7 capture, the real controller reached readiness through its streamed-log fallback. Read-only source tracing found that the fake producer and HTTP transport did not implement the primary ready-file channel used by the same controller in production.

## Diagnosis

The real cloudbench-run.sh creates a run-bound ready file before logging readiness, waits for release and removes both files. The fake run_fake_driver only logged readiness. Its ProxyHandler delegated runtime evidence but returned404 for the ready URL. Therefore the fake could not exercise the primary GET path and forced compatibility-log observation.

The owning regression executes the actual fake-driver function through its barrier lifecycle, stopping via a trace boundary before unrelated benchmark-result work. It builds the existing production status Handler, applies the actual fake ProxyHandler, uses a real loopback HTTP server and executes the unchanged controller release_start_barrier function with real curl. The original producer fails because no ready file appears. The candidate succeeds with zero compatibility fallback calls. Wrong-token, absent-marker, symlink and traversal requests remain404; a real delayed producer stays unready before running; a pre-readiness error publishes nothing; compatibility-log fallback remains valid.

The isolated scenario7 capture passed and did not reproduce cumulative whole-unit failure. Its CLI timings do not justify a lazy-import optimization. No exact original ready publication timestamp existed because the primary file was missing. The controlled regression records actual marker mtime and consumer latency, around29ms in one local run, but that is not a full-suite speedup or evidence of sufficient savings. There are50 syntactic run_controller call lines in the fixture, including conditional/looped sites; this is not50 measured delays and cannot be multiplied into a runtime claim.

Archive review identified the earlier process-identity and repeated fake-provider work cases as related investigations of the same whole-timeout symptom. Their completed microchecks did not establish full native acceptance. This is a distinct producer/adapter fidelity defect, not permission to shorten polling, remove retries or alter task readiness authority.

## Solution

External candidate only: publish the exact ready marker at the fake driver's existing ready boundary, remove ready/release files after the real barrier loop, and delegate only that exact current ready URL to the already-loaded production status handler. The delegation rejects absent, symlinked and noncanonical ready paths. Other fake routes retain their original behavior. The controller, periodic fallback, sleeps, deadlines, retry counts, benchmark assertions and runtime/cleanup authority are unchanged.

The identical owning control fails original source and passes five unchanged candidate runs. The complete existing directly registered fixture process-cleanup suite passes. The initial test export omitted PurePosixPath for its pre-readiness error branch; that harness NameError was corrected and is retained separately from product evidence. No whole-unit or scenario7 rerun was performed for this patch. Native original1200/five/eight acceptance remains required; this case remains OPEN and grants no native task, resource, financial or deployment credit. Code-only golden reference is the repository's real driver and status handler, cited above; no approval-gated behavior is changed.

### Pre-integration condition-wait correction

Independent review blocked the initial9e446 candidate because its new readiness poll used a literal time.sleep(.01), exceeding this owning file's zero-sleep baseline. That candidate was not applied. The final correction uses the canonical condition_wait.wait_until with the same ready-or-driver-ended predicate and original three-second deadline, then retains the original marker assertion. No alias, dynamic literal or baseline change hides a sleep.

The unchanged f8 checker ran against the full current tracked-test overlay and its actual f8 baseline: exit0,859 sleeps in273 files, with no skipped historical comparison. The owning file remains at zero literal sleeps; all17 embedded fake-Python sleep ASTs match original source. The final condition-wait version passed five unchanged protocol repetitions and the full owning suite. Original whole native acceptance remains pending.

## Human feedback

The parent required a minimal fake-producer and exact-URL correction, with no generic file-serving widening, no controller/clock/retry/ACK-authority changes, and no whole-fixed claim before native acceptance. All source work stayed external pending independent review.

## Reusable lesson

A fixture must implement the primary durable protocol, not merely a compatible console message. Exercise the real producer and consumer together, retain negative identity/path controls, and keep correctness proof separate from performance sufficiency.
