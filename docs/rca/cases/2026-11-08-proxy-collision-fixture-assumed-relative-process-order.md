---
id: 2026-11-08-proxy-collision-fixture-assumed-relative-process-order
date: 2026-11-08
title: Proxy collision fixture assumed relative process sleep order
surface: harness
component: cloudbench-proxy-review
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-proxy-review.test.py test_collision_reported_after_initial_scan_returns_rotation assumed the fake child published its collision before the helper's live-PID success branch based on relative sleeps alone
symptoms:
  - "expected rotation98 got0"
  - "Failure output contained only the backend proxy attempt header"
tags:
  - proxy
  - fixture-ordering
  - child-cleanup
sources:
  - commit 37af2d9da532542d12121eca17fe222164ecf626
  - plan:.context/deploy-google400-stabilized/rca/f4be830086704370be3112b51e84c5ca.json
  - plan:.context/rca-google400/37af2d9-final-validation/proxy-readonly-rca.json
  - plan:.context/rca-google400/37af2d9-final-validation/proxy-candidate/handoff.json
repro: python3 scripts/tests/cloudbench-proxy-review.test.py
status: fixed
---

## Problem

Full53 on frozen 37af2d9 reported one proxy-review failure among nine tests:
`test_collision_reported_after_initial_scan_returns_rotation` expected rotation98
and received0. The failure printed only the attempt header. The native log is
`/home/boxes/rose-deploy-google400-workers/cloudbench-controller/.context/cloudbench-local/run-3k66rskc/environment.log`.
The parent subsequently recorded full53 terminal with ten gates passing, one
controller failure, and all eleven roots cleanup-quiet. No failed receipt is
changed or credited by this case.

## Diagnosis

The fixture starts a fake child with `command sleep .04`. The parent uses .01
and .10 real sleeps while its fake clock advances independently. Relative
sleep durations do not establish publication order across processes. The
production helper scans this attempt's log, settles, charges the bounded step,
and can return0 for a still-live backend proxy. The retained header-only output
and return0 establish that the collision was not observed before that success.
The original temporary fixture directory was removed; the exact full53 process
interleaving remains UNKNOWN. This is not an evidenced provider outage.

Controlled scheduling reproduced the assumption failure: a private PATH sleep
wrapper delayed only the child's original .04 command by .35, forwarding every
other sleep unchanged. The exact original assertion failed with expected98
received0 and header-only output (native1). The same wrapper, environment and
owning command passed after ordering the collision explicitly (native0). This
proves the controlled fixture hazard, not the historical full53 schedule.

Relevant helper, test and environment-suite bytes were identical across main
bf26a925, bd5db328 and 37af2d9 and the owning worker. Incremental attribution is
NOT_INTRODUCED; whole-branch attribution remains UNKNOWN. The helper SHA256 is
`166f249b055d9b5ebf6d28cb54c7f522e4ad0ab5652cfe670ecc58388a947e2d`;
the original test SHA256 is
`297d38c1a8faf0408e59beded04760478b9945f676be5357ce5de87f72391ecb`.

Archive searches used the exact function/error and the behavioral terms
`relative sleep fixture process ordering collision`; exact-text searches found
no existing case with this first bad boundary. The related
`2026-10-28-proxy-late-bind` concerns a missing production post-reap collision
scan. That scan is present and unchanged here. Removing only that branch from
an ignored helper made the revised fixture fail (expected98 received1), proving
that the production late classifier is still required. Fixture-child cleanup
cases are related lessons, not this incident's same first bad boundary.

## Solution

The reviewed fixture is integrated in the checked-in test. It retains the original child .04, parent .01/.10, fake-clock charges,
helper budget6, replay timeout10 and original assertion98. It forwards actual
`tail` arguments/output/status and records completed scanning of the exact
fixture log. At the original bounded-charge phase it releases and joins the
exact fake child, then forwards the original charge once. Assertions require
scan < release < collision publication < join, followed by the original98.
A registered delayed-child case exercises the same boundary.

Independent review rejected the first phase-only candidate (P1 NOT_CLEAR): a
helper returning before the phase hook could leave its child blocked on the
FIFO. That candidate and its earlier proofs remain preserved as superseded.
The revised common fixture opens its private FIFO read-write and installs EXIT
cleanup before invoking the helper. Cleanup preserves the primary exit code,
captures this private Bash shell's own job identities by direct `jobs -p`
redirection, queues release without waiting for a reader, waits those exact
children, and closes the FD. It sends no signals and makes no host-PID identity
inference. The phase-success hook still joins its exact child normally.

A registered early-return control forks the real fake child then returns0 before
the phase hook. It must preserve phase-error92 and its message, and prove cleanup
joined the child with expected bind-error exit1. Three light owning cases passed
without an external cleanup trap. A controlled missing-cleanup variant failed
that registered case; an identical external safety harness released and joined
the old blocked child, so no deliberate timeout/leak was executed. The same
command passed with permanent cleanup restored. The post-reap-only removal
negative still failed. All supervised light proofs were terminal/quiescent,
without orphans, remaining children, TERM or KILL.

Exact commands, receipts, logs, old versions and hashes are retained under
`.context/rca-google400/37af2d9-final-validation/proxy-candidate/`.
The current handoff SHA256 is
`18ed33ecf958374026870db46f15396a5527625723d134ffcd8abd6469527383`;
the reviewed diff SHA256 is
`906c21c468dc087cf470455b5e5b2d3a8af76cbc77fbae30b9aa922a0de813a3`.
Final independent review cleared the failure-safe revision. After integration,
the complete canonical owning file passed all 11 tests in 2.027 seconds. Its
supervisor recorded native exit0, quiescent=true, no orphaned or remaining
children, no TERM/KILL and no error. Receipts are preserved under
`.context/rca-google400/37af2d9-final-validation/proxy-canonical-owning/`.
This fixes the demonstrated fixture mechanism. The historical full53 schedule
remains UNKNOWN; the next normal full controller gate, deployment and physical
acceptance remain required.

## Human feedback

None recorded specifically for this fixture. Parent coordination and independent
review findings above are agent review feedback, not attributed human instruction.

## Reusable lesson

Use observed phase ordering to establish a late asynchronous fault. Preserve the
real classifier and its negative control. Install exact-owned fixture cleanup
before launching a child, including when the expected phase is never reached.
