---
id: 2026-10-17-benchmark-poll-civil-clock-used-for-elapsed-deadlines
date: 2026-10-17
title: Benchmark polling uses civil time for elapsed deadlines while its independent backstop uses monotonic time
surface: harness
component: benchmark-agent-poll-elapsed-clock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _poll_agent start and elapsed comparisons use time.time for durations, unlike the existing loop-time backstop
symptoms:
  - Timeout after 2900s (task timeout=900s)
  - Timeout after 1392s (task timeout=1200s)
  - Forward civil-clock divergence prematurely expires an under-budget terminal snapshot in the actual polling owner
  - Backward civil-clock divergence extends the deadline beyond genuine elapsed expiry
tags:
  - benchmark
  - elapsed-clock
  - monotonic
  - timeout
sources:
  - commit f60a39e19f4402e98cde73419d7777e7c3a52df5
  - benchmark run auth-repair-original30-f60a39e-20261017
  - agent 64a443b5-2529-412f-8beb-41c306bb46f8
  - agent 38bb2fbb-6a24-4786-b6ae-897ebe55cbca
repro: Private actual benchmark run_all_tests registrar selected six new elapsed-clock registrations; unchanged tests fail four registrations before the eight-line candidate and pass all six afterward
status: open
---

## Problem

Two original task failures remain immutable at source f60, group
259c460f-7a3c-4a2d-bcdf-b45e5172c70f. Signup-already-registered reported
2905.4 seconds and `Timeout after 2900s (task timeout=900s)`.
All-options-fail-assistance reported `Timeout after 1392s (task timeout=1200s)`.
Neither result is regraded or credited as a semantic PASS here.

Retained observer timestamps advanced 2772.160565 seconds while the report
card's elapsed counter advanced 30.2 seconds, then 1400.409971 seconds while
that counter advanced 29.8 seconds. This establishes divergence in the recorded
clock domains. It does not establish NTP correction, devbox pause, host suspend,
provider latency, or which mechanism caused either original task outcome.

The parent recorded an infrastructure execution-clock classification with
`semantic_pass_credit=false` in root-timeout-classification.json. That is the
parent's operational classification, not additional physical-cause proof or a
replacement native grade. This case establishes a separate deterministic
polling-clock mechanism; incident attribution and outcome verification stay OPEN.

## Diagnosis

### What, where, why, proof, problem

- **What:** a civil-clock change can prematurely expire a task or extend its
  deadline, independently of its elapsed execution/wait budget.
- **Where:** `_poll_agent` takes its start and eight duration-related reads from
  `time.time()`. The report card uses `time.monotonic()` and the independent
  `_run_with_agent_execution_backstop` uses event-loop time.
- **Why:** epoch/civil time can move independently of monotonic duration time.
  The task timeout check runs before the next terminal-status GET. Returning a
  COMPLETED snapshot from that diagnostic GET does not remove the timeout reason.
- **Proof:** the actual imported polling owner fails independent-clock controls:
  civil +2900 with elapsed +30 prematurely expires; civil -2900 with true elapsed
  +901 permits a terminal snapshot past the 900-second budget. The 1200-second
  sibling is exercised separately, with true elapsed +1201 still expiring.
- **Problem:** elapsed-duration owners share an adjustable epoch-clock basis
  despite an existing monotonic backstop. This is a clock-contract mismatch,
  not a demonstrated model-intelligence, authentication, provider, or site defect.

The signup root has 27 retained dumps spanning 146.064 seconds by filename
realtime, a browser verifier score 1.0 and a completion-summary capture. Those
are counterevidence to a simple semantic-rejection account; they do not prove
when the root became terminal or that polling should have accepted its grade.
The separate all-options root has a request-only execute capture and a later
completed execute capture separated by 1390.295 seconds in filename time. The
later provider round trip is 2.905 seconds and emits its first browser spawn.
No retained browser trajectory or assistance judgment establishes that this
second failure is the earlier semantic handoff defect. A request-only capture
is not a completed provider attempt or a zero-cost call.

The exact retained small evidence sources are hash-bound privately:

- `clock-discontinuity-observation.json`: c12b9e915c077fc9ee6fc53524935fa821368f27134b52db0db43a1553fb8715
- `root-timeout-classification.json`: 0f2437e9de82440c99cfee3eab00bad2ef70ac7b16bd83f60c1d5ce5ddb6a96e
- `timeout-failure-log-slices.private.json`: 38b237eaf1cc5955b5b61cf70f2ceb1454948c704325a61bcf30ccb2ed08bc77

These source records remain unchanged; the classification record is not a native
export, terminal controller proof, semantic PASS or physical-host diagnosis.

### Archive search and boundary comparison

The initial symptom searches were `Timeout after task timeout time.time` and
`monotonic clock jump suspend benchmark`. Both were repeated against an isolated
copy of the exact f60 archive with all 938 original case blobs verified.
Search logs are retained in the private documentation packet.

The August 3 clamshell case's Solution requires awake-host validation and
explicitly rejects increasing budgets; its Human feedback records none. That
case has direct power-log evidence of suspension. This run lacks that evidence,
and this reproduction proves an owned clock-contract mechanism instead.
Therefore this is a distinct OPEN boundary, not a declaration that the old
configuration incident has recurred. The October 2 process-birth case is a
related use of adjustable civil time, but its owner is process identity, not
polling duration. Its Solution and Human feedback were also reviewed; no old
case or prior fix is rewritten.

### Owning reproduction and exact provenance

Private artifacts live under the current run's `signup-clock-rca/` directory.
`run_registered-v3.py` imports a physical private copy of the actual f60 polling
module and asserts its absolute `__file__` and expected whole-file SHA before
executing tests. Other imports fall back to the frozen f60 dependency tree.
It invokes the real `benchmark.blackbox.py:run_all_tests` registrar and selects
only the six new registrations. It does not mirror or extract `_poll_agent`.

Commands actually run with the installed private Python, with no installs:

```text
/home/boxes/rose-auth-control-deploy-verification/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-f60a39e-20261017/signup-clock-rca/run_registered-v3.py baseline
/home/boxes/rose-auth-control-deploy-verification/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-f60a39e-20261017/signup-clock-rca/run_registered-v3.py candidate
```

Only the expected-owner hash phase argument differs; the registered test bytes
and assertions are identical. The baseline exits 1 with four failed and two
passed registrations. The candidate exits 0 with six passed registrations,
covering 19 synthetic scenarios. Genuine elapsed 901/1201 with ACTIVE or
COMPLETED data still times out before terminal processing; backward civil time
cannot extend that budget. Other controls preserve FAILED status, no reset on
progress, real disabled-Polar behavior, a 100-second remaining payment budget,
570-second tree silence and an 11-second chat wait. Approval handling is set to
ignore on test-local task copies to isolate this polling boundary. GET edges and
payment side effects are fake; the budget/control calculations are the real owner.

Both corrected registered runs hard-deny DNS/socket connect and record zero
network attempts and zero transmitted requests. All commands joined normally;
these selected tests launch no child processes. This is selected owning proof,
not a full benchmark-domain, full G3 or unchanged native task PASS.

Setup failures remain visible. The first scratch harness omitted the attention
GET edge, attempted DNS for offline.invalid, and failed before reaching a
service; it is not causal RED evidence. A later v2 fixture used ERROR as if it
were a terminal agent status, although the real status is FAILED. Its 4/1 result
and invalid draft freeze are retained and explicitly superseded, not erased or
called green. Final v3 proof is generated from actual raw result JSON.

## Solution

A PRIVATE, unadopted candidate changes exactly eight reads in `_poll_agent` from
`time.time()` to `time.monotonic()`: its start, task elapsed, three remaining or
post-response payment checks, two chat-wait reads, and the shared activity/tree
poll/stall clock. These existing relative differences now share one elapsed
basis. No absolute event/archive timestamp, remote updatedAt, run_single_task
duration, model, task definition, evaluator or source-timeout number changes.
The independent 7200-second loop-time safety backstop and the original 900/1200
bounds remain. Existing in-flight GET after-deadline acceptance is outside this
candidate and is not silently repaired or used to accept late results.

The deeper proven owner is the shared elapsed-clock contract. Forward premature
expiry, backward extension and relative payment/chat/stall accounting are
concrete sibling controls; no failed Step 5b rung or whole-class elimination is
invented. Monotonic elapsed includes waiting; this is not CPU/provider-only time
or permission to subtract suspend intervals. Awake-host proof remains required.

The complete old test-module AST restores exactly after removing only the eight
new helper/test functions and six registrations. All 2537 original assertion
ASTs and multiplicities remain, with 2546 assertions after addition. Independent
source review also restores the complete old runtime AST by reversing only the
eight clock reads. Runtime patch SHA is
781e5dcf0b8b2406c3ed57b3c93d251a60f07ea16140d331d81d54a63448d203;
test patch SHA is
3763878ce5c16ab38881a749bb1e843f64380957d048ba10e5ddeb13a69ec239;
final private proof SHA is
6ea027bae5351cd09bdeb33d5ed7fb1d0c0494ea9bf877eb3f6860ad1ee4561b.

At scale this replaces eight existing standard-library clock reads. It adds no
model call, provider allocation, service, persistent state or polling frequency.
No billing, native improvement or rollout claim follows from the synthetic tests.
Canonical merged-source registration/full owning-domain/full G3 qualification,
awake-host unchanged-task verification and final original30 proof are UNPROVEN.
Do not adopt the candidate or close this case from this documentation packet.

## Human feedback

The parent authorized a private candidate only after actual baseline RED, with
a maximum narrow runtime scope. Preserve genuine deadlines, terminal errors,
attention/Polar/payment semantics, absolute timestamps and original failed
verdicts. Do not change durations globally, increase caps, refund suspension,
accept late graded results, or confuse mechanism controls with a native cure.
No deployment approval or active-source mutation was authorized by this packet.

## Reusable lesson

Use a single monotonic basis for relative deadlines and activity durations, and
keep absolute timestamps separate. Prove the actual owner with independent clock
controls, including backward motion and real elapsed expiry. A matching clock
vulnerability does not by itself establish an observed host incident's cause.
Preserve failed outcomes and require unchanged native verification on an awake
execution host before claiming an outcome repair.
