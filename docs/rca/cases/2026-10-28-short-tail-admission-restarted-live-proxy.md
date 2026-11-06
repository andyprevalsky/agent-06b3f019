---
id: 2026-10-28-short-tail-admission-restarted-live-proxy
date: 2026-10-28
title: A four-second minimum wait step killed live proxies with readiness time left
surface: harness
component: cloudbench-data-plane-proxy-readiness
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_start_data_plane_proxy broke its live-process readiness loop when wait_budget was less than 4, then terminated and relaunched that still-live proxy
symptoms:
  - 'test_dead_tunnel_is_replaced_before_readiness: AssertionError: 1 != 0'
  - 'test_rejected_lifecycle_still_fails_and_reaps_at_deadline: AssertionError: 2 != 1'
  - 'HTTP failures do not prove process failure'
tags:
  - cloudbench
  - proxy
  - readiness
  - budget
  - process-ownership
sources:
  - PR #1627
  - commit e473edb75612b721ae670dd994d9296cf56b02e0
repro: python3 scripts/tests/cloudbench-status-readiness-observability.test.py
status: open
---

## Problem

The full controller gate on the frozen integration source reported seven
failures. The owner separately attributed six auth-fetch failures to ENOSPC;
this case addresses only the remaining proxy-readiness contract regression.
No provider or disk-failure cause is inferred for it.

The unchanged local owning test reproduced two failures on
`e473edb75612b721ae670dd994d9296cf56b02e0`: dead-first recovery returned one
instead of zero, and rejected HTTP readiness launched two processes instead
of retaining one live process until its deadline. The other three tests
passed. Original output is retained at
`/var/tmp/deploy-1627/proxy-tail-rca/original-before.log` and
`readiness-before.log`. These original failures remain failed evidence.

## Diagnosis

Critical path: start proxy -> trigger lazy DNS -> settle -> inspect process
liveness -> allocate remaining readiness step -> query lifecycle HTTP ->
return ready or retain the same initializing process until the deadline.

At `scripts/lib/cloudbench-env.sh:1828`, the admitted wait budget was the
minimum of the original fifteen-second ceiling and remaining readiness
budget. A newly added `wait_budget >= 4` guard broke the live-process loop
when only one to three seconds remained. Control then unconditionally
terminated the still-live proxy and, if charged time remained, launched
another. This converted HTTP unavailability into a restart without process
failure and discarded initialization progress. The dead-first case needed
two more observations in the replacement's same process incarnation; the
short-tail guard prevented them.

The deepest proven cause is the mismatch between fixed-step admission and
remaining-budget semantics: a full three-second probe plus one-second sleep
was treated as indivisible. The source already had an HTTP-independent
process-liveness contract. Keeping that contract requires sizing the probe
and optional sleep to the remaining budget, not terminating a live process
because a full-sized step no longer fits.

Archive searches were `dead_tunnel_is_replaced_before_readiness HTTP failures
do not prove process failure` and `proxy thaw bounded budget`. Read
`2026-10-28-proxy-thaw-budget` before proposing a correction. That is a
related predecessor, not this incident: it addresses a host pause consuming
the last charge before a post-thaw observation. This case is the distinct
short-tail admission regression introduced while preserving that budget.
The earlier thaw and original controller evidence are not rewritten.

## Solution

The proposed two-file patch sizes the first probe to the remaining step.
Reserve a one-second sleep only when more than one second remains, and use
`min(3, wait_budget - sleep_budget)` for the first curl. The one-second tail
still receives a one-second probe without sleep. A two-second tail receives
a one-second probe and one-second sleep; a three-second tail receives a
two-second probe and one-second sleep.

The existing once-only post-thaw probe is preserved. Its limit must fit after
the initial probe and reserved sleep inside the same step. Aggregate fixed
curl and sleep limits remain at most both the original fifteen-second
ceiling and remaining readiness allocation. There is still exactly one
charge call per wait step. An optional minimum charge defaults to zero for
all existing callers; only wait steps request one second so a failed
subsecond response cannot spin forever before the integer clock advances.
The counter remains monotone. Default readiness timeout 180 seconds,
ceilings, HTTP acceptance criteria, termination grace and late collision
rescan are unchanged. No new deadline or live-provider call is introduced.

Patch SHA256:
`7081339d8c7f74fae2806549748d151512aed4fd353a660c6a9d198c843063ae`.
Candidate helper SHA256:
`97fa1431ad1963b5a0cc1fba1de9476f4e71682ca235382982bd706fd94e6d46`.
The patch, source hashes and complete report are under
`/var/tmp/deploy-1627/proxy-tail-rca/` as `proposed.patch`, `manifest.json`
and `report.md`.

Exact original reproduction, run in the frozen integration checkout:

    . /var/tmp/deploy-env.sh
    python3 -B scripts/tests/cloudbench-status-readiness-observability.test.py

Exact same test bytes against the temporary candidate, without source edits:

    . /var/tmp/deploy-env.sh
    python3 -B /var/tmp/deploy-1627/proxy-tail-rca/after/scripts/tests/cloudbench-status-readiness-observability.test.py

The before/after snapshots contain byte-identical copies of all five owning
readiness tests. Before: two failures; after: all five pass. Tests use real
local child processes, fake provider/HTTP operations, and assert every
launched PID is reaped. No external service is called.

The permanent supplemental owner suite is
`scripts/tests/cloudbench-proxy-review.test.py`, already reached by
`scripts/tests/cloudbench-env.test.sh`. Its candidate retains the previous
five test methods and adds two methods for explicit one-, two-, and
three-second tails and zero-clock progress. The timeout-five expectation of
zero probes encoded this regression and now requires one bounded probe.
Repeated-stall count changes from two to three to include the legitimate
normal one-second tail after the once-only thaw pair; an additional assertion
requires exactly one post-thaw marker. No extra budget or repeated thaw
allowance is granted. Initial failures of those obsolete expectations remain
in `budget-after.log`.

Both final commands ran together five times under `set -e`:

    python3 -B /var/tmp/deploy-1627/proxy-tail-rca/after/scripts/tests/cloudbench-status-readiness-observability.test.py
    python3 -B /var/tmp/deploy-1627/proxy-tail-rca/after/scripts/tests/cloudbench-proxy-review.test.py

`sealed-1.log` through `sealed-5.log` each record five readiness tests and
seven budget tests passing. The final repetition ran 2026-10-28
22:52:04-22:52:06 UTC. Negative controls preserve HTTP rejection, exact
process ownership, finite repeated stalls, single monotone charge, fixed
aggregate limits and once-only thaw probing. A frozen wait-clock case
requires probe limits 2, 1, 1; charges 1, 2, 3; and one process launch.
Shell syntax and `git apply --check` also passed.

The parent independently ran the unchanged five readiness tests against the
candidate helper and the candidate seven-test budget suite; both passed.
Technical approval is recorded in
`/var/tmp/deploy-1627/proxy-tail-rca/parent-independent-review.json`, bound to
the exact patch hash above. Approval does not establish integration or full
controller success.

Status remains OPEN: the case and patch were prepared only in temporary
paths. At handoff the owner was waiting for the active frozen checks to end
before source application. Integrated owning-suite verification, the full
controller gate, and the final fresh deploy sweep remain required. The
six ENOSPC failures are owned separately. No live tunnel recovery, deployed
outcome, or resolution of the prior thaw case is claimed here.
Golden reference: not applicable to this ordinary shell budget correction;
no prompt, schema, model action or product authentication policy changed.

## Human feedback

The requester required the original readiness tests and their assertions to
remain unchanged, no timeout or ceiling increase, no charged-counter rewind,
no HTTP-driven restart of a live proxy, one fresh post-thaw probe at most, and
source application only by the parent after the frozen boundary. The parent
accepted revising the newer incidental probe counts only when the corrected
short-tail contract retained stronger boundedness and once-only assertions.
All original failures, previous candidate evidence and exact patch hashes
must remain preserved. Freedom and the separate AutoFill HOLD remain intact.

## Reusable lesson

Size each readiness observation to the remaining budget and retain a live initializing process until that budget is consumed instead of requiring a full-sized wait step.
