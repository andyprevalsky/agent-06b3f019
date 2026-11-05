---
id: 2026-11-03-cli-deploy-validation-harness-interference
date: 2026-11-03
title: CLI deployment validation rejected inherited Node options and nested native tracing
surface: harness
component: deploy-validation-harness
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Test fixtures omitted inherited preload state and attempted a second ptrace owner
repro: NODE_OPTIONS=--require=$PWD/back-end/scripts/blackbox-kernel-proxy-custody.cjs bash scripts/tests/backend-coverage-sharded.test.sh
symptoms:
  - merged c8 report must run with the raised heap
  - Exception occurred in preexec_fn
  - Missing expected rejection
  - wss.on is not a function
tags:
  - validation
  - fixture
  - node-options
  - ptrace
sources:
  - commit b759642eab648a0c6868fba1eb5dda85facd3a10
  - commit 9f34c17ec5a9567a16de5f5484799b7659a7524a
  - agent ph7eybjwep2b2m7sr3kqa03zdd8hhq93
status: fixed
---

## Problem

The CLI integration deployment at `a4b3f77bb3e561773192ef618d57240b5bb439e3`
failed two independent validation boundaries. These were harness failures;
neither receipt established a defect in CLI setup, authentication or E2B launch.

1. `backend-coverage-sharded.test.sh` expected the c8 child environment to contain
   only `--max-old-space-size=6144`. The required zero-allocation preloader was
   correctly preserved before that option, making the exact comparison fail.
2. The local controller command was wrapped in `strace -f`. Six controller
   fixture cases themselves use `PTRACE_TRACEME`, which failed before exec when
   the child already belonged to the enclosing tracer.

## Diagnosis

The shard coordinator passes inherited `NODE_OPTIONS` through
`coverage-report-heap.sh`, which appends the heap cap. The test asserted an empty
inherited environment despite running with the required Kernel allocation guard.
The unchanged command, with the actual preloader inherited, failed locally and
printed both options. Changing only three test lines made the identical command
pass every shard, unit, probe, failure, cleanup and heap-override control. The
new exact comparisons preserve both inherited options and ordering. The override
case also retains the guard while adding `--trace-warnings` and its 4096 MB cap.
No production helper, coverage threshold or timeout changed.

The controller's exact owning test was run under the original Python 3.11
runtime with and without the enclosing signal-only `strace --seccomp-bpf -f`
wrapper. The wrapped test exited 1 with `Exception occurred in preexec_fn`;
the direct test exited 0. A diagnostic ptrace trace recorded
`ptrace(PTRACE_TRACEME) = -1 EPERM`. Filtering traced syscalls does not allow a
second ptrace owner. The direct invocation preserves the original fixture,
assertions, native scheduling and time limits.

Private evidence is retained in `.context/cli-readiness-rca/`: the
`nov03-heap-before.log`, `nov03-heap-after.log`,
`nov03-coverage-heap-fixture.json`, `nov03-two-failures-review.txt`, and
`nov03-ptrace-owning-results.json` receipts bind the executed commands and source.
The independent review was collected from turn
`01a1a36e-17a7-7c71-accc-cf6ec07a25be`.

## Solution

Commit `b759642eab648a0c6868fba1eb5dda85facd3a10` fixes the three test lines.
The local deployment plan invokes the unchanged controller directly, without an
outer ptrace observer. On that source, all 86 deployment structural gates passed
in 1688.6 seconds. The full controller then passed its shell components, all
21 wall-clock tests and 518 selected regressions (1028 deselected) in 2228.3
seconds overall. Full agent coverage also passed 124 domains, 214 demo tests,
176 unit tests and the configured 85% coverage threshold.

These receipts validate the harness repairs. They do not claim the CLI deployment
is complete: full backend, live, review and production acceptance gates remain
separately required. Original failed logs are retained.

## Boundaries not explained by these repairs

An earlier Chromium fixture failed before publishing its dynamically allocated
CDP port. Its original stderr and pre-cleanup state were not captured. The
unchanged callback and subsequent full agent suite passed with native diagnostics
retained, but neither establishes the original startup cause or a startup repair.
That historical cause remains unknown. Earlier exit-143 sender identities and
the interrupted backend queue's sender also remain unproven.

## Human feedback

Preserve the zero-allocation guard and the 100 verified Kernel proxy deletions.
Do not weaken assertions, timeouts, coverage thresholds, payment verification,
Mac acceptance or Freedom protections to make deployment pass. Keep one deploy
coordinator and do not restart active validation cohorts.

## November 4: preloaded custody and WebSocket replay fixtures

The first full sharded backend run failed two unit files independently of its
strict treasury failure. The treasury failure remains recorded separately and
is not cleared by these unit repairs.

`blackbox-kernel-proxy-custody.test.ts` replaced global fetch with its counter
mock, then required a custody module already cached by `NODE_OPTIONS`. The
cached require did not reinstall the guard around the new mock, so the SDK
create call resolved and the expected-rejection assertion failed. The identical
owning command with the real custody preload failed before the repair and
passed after explicitly installing custody around the test's replacement
fetch. The existing SDK rejection, zero upstream create calls, reuse reads,
gateway matching and real local HTTP proof assertions are unchanged. No
production guard code changed.

`oauth-feedback.test.mjs` executed the real producer slice with an empty class
as its WebSocket server. The upstream producer now registers its listening
handler. All seven cases therefore threw `wss.on is not a function` before
classification assertions could execute. A network-free EventEmitter stub now
publishes its address on a queued listening event. Both replay contexts use the
same stub. All seven original cases pass, with zero skips, both directly and
through the unchanged backend unit wrapper. Producer and worker source bytes
were not changed; all positive and negative classification assertions remain.

Private before/after evidence is in `.context/cli-readiness-rca/nov04-kernel-*`
and `nov04-oauth-*`. The independent OAuth repair was collected from turn
`01a1a3dc-0c50-73d0-950a-d65240edeefd`. These owning-test passes do not replace
full backend coverage or establish return of any treasury funds.

## Reusable lesson

Preserve inherited process state explicitly in fixtures. A cached module does not
reinstall its side effects after a test replaces the target, and a diagnostic
tracer still owns tracing even when its output is filtered. Test doubles must
implement the real interfaces executed by the code under test. Native failure
records and post-repair full validation remain distinct evidence.

## November 5: isolated checkout and native startup evidence

The first staged run on `ce2742ae0` exposed preparation failures rather than a
reason to alter production behavior. An interrupted environment copy left the
structural worker without pytest; the backend worker omitted its Python
environment. Sparse checkouts also omitted tracked benchmark history consumed
by the backend, agents and /descend tests. Restore the pinned environment and
the exact committed history in a terminal worker, retaining its original logs.
The unchanged subscription test, span-history domain and four affected backend
domains then passed. The focused backend runner returned its intentional
partial-coverage exit 3; this is not full coverage acceptance. The original
browser shutdown assertion was not reproduced by the missing-Python controls,
so its historical cause remains unknown.

Cloud smoke failed at the native `flyctl status` exec before dispatch because
the installed binary was outside PATH. Its original producer did not record a
startup cleanup seal. Later empty process scans cannot manufacture that seal.
The revised producer writes narrowly typed startup evidence for future runs.
Compatibility for the audited original producer permits only a different
token and isolated native directory after fresh exact-scope process checks.
It preserves the original ten UNVERIFIED outcomes and cleanup debt and grants
no test or historical cleanup credit. Conflicting resources, unknown source,
missing observations and live owners remain rejected.

The identical compatibility regression failed before the repair and passed
after it; five consecutive focused runs and all 168 coordinator tests passed.
Evidence remains under
`.context/cli-nov05-review/` and the isolated review checkout's
`.context/nov05-cleanup-repair/`. These proofs do not establish a successful
smoke campaign, global coverage, financial release, or completed deployment.

The named-workspace setup fixture also inherited an explicit
`ROSE_SYSTEM_PG_DB_NAME` from its isolated executor. Runtime correctly honored
that override, while the fixture expected its generated `ws_alpha` name.
Clearing the inherited override before applying each case's own overrides
made the identical command pass five consecutive runs. The explicit-override
negative control still fails when runtime ignores its configured name. This
two-line fixture repair changes no database code, assertion, timeout or real
database; its command stubs and proof are retained in
`.context/cli-nov05-review/setup-db-fixture-current.json`.
