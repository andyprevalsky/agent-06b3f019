---
id: 2026-10-26-browser-resume-custody-test-assumed-worker-overlap
date: 2026-10-26
title: Browser resume custody test released its create before the incompatible contender entered
surface: harness
component: browser-session-custody-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: runBrowserResumeCustodyCases released the fixture create after one second without establishing that the incompatible worker had checked the active ledger
symptoms:
  - "assert(!results[1]!.ok)"
  - "browser-session-resume-custody.cases.ts:302:11"
  - "browser-session blackbox failed"
tags:
  - browser-session
  - resume-custody
  - concurrency
  - fixture-lifetime
sources:
  - commit ff4d24295df7863a4b92f761892b4310f91aa9a6
  - commit 20ba31ca2470f3a6399375a9f9c1e160dcd8b347
  - agent 6731984c-4b1b-4f4a-9786-65b2f7bbc511 delegated deploy-gate investigation
repro: back-end/src/tests/blackbox/browser-session.blackbox.ts --resume-custody-only
status: fixed
---

## Problem

The full backend coverage run passed 318 unit files and 225 of 226 blackbox
domains, but browser-session failed at the existing negative custody assertion.
Original evidence remains under
`.context/test-runs/backend-coverage-failed-20261026-194551-1480274/`, including
server, runner, host-pressure, domain logs and raw V8 coverage. Their hashes and
source hashes are retained under `.context/rca-browser-custody/`.

The retained parent coverage file
`raw-v8/coverage-1663556-1793043195154-0.json` records nine scenario-loop entries,
zero Kernel native branches, one fresh worker and 189 calls to the incompatible
create-entry poll. This identifies the ninth Browser Use scenario,
`incompatible`, rather than the following `manual-follow` scenario that shares
the assertion. Ten context creations include the preceding lazy-retirement
fixture. The historical run did not retain worker/provider timing events;
its exact scheduling timestamps cannot be reconstructed.

## Diagnosis

The path is independent worker startup -> production `resumeBrowserSession` ->
`withBrowserResumeLifecycle` -> real local Prisma ledger -> local fixture
provider create -> hydration -> terminal worker outcome. Production rejects a
request whose compatibility differs from the active `STARTED` operation. Once
the previous operation finishes, a later request can legitimately create again.

The original fixture held its first create response for one second, polled only
until that create arrived, and then forked the incompatible worker. Forking did
not prove that the second worker reached the ledger before the timer expired.
The fixture therefore sometimes tested sequential requests while asserting
concurrent rejection. The first incorrect boundary is the fixture's assumed
lifetime overlap, not the production ledger's rejection semantics.

The unchanged standalone fixture first passed. A scratch scheduler then added
a two-second startup delay to only the incompatible contender, preserving the
original test source, native worker, production code, assertions and ten-second
worker deadline. It reproduced the exact assertion at line 302. The trace shows:
first create at 19:49:15.721Z, its response at 19:49:16.723Z, first success at
19:49:16.773Z, second create at 19:49:18.723Z, second success at 19:49:19.775Z.
This establishes the mechanism without inventing the historical schedule.
The same controlled native entrypoint passed when the proposed fixture was
loaded from scratch through a source overlay.

A permanent `incompatible-delayed` scenario starts the contender 1.5 seconds
late, beyond the former one-second fixture window but within the unchanged
ten-second worker deadline. With only that regression added, the native command
failed at the same negative assertion (shifted to line 312), after eleven
context creations: the ordinary incompatible case had passed and the added
case reproduced the failure. Logs are `permanent-regression-before.log` and
`native-controlled-{before,overlay-after}.log` under the scratch directory.

Archive searches were `browser-session-resume-custody results[1] custody`,
`parallel browser resume lease acquired twice`, and
`browser resume incompatible in-flight test timer`. The October 23 rejected
provider-create custody case is related but concerns a production ledger that
failed to release; this incident concerns a test that released its provider
response too soon. The live-display handler-release case is another related
fixture-lifetime error, not this same owning boundary.

Golden references use explicit entry and release synchronization:
`openclaw/src/gateway/approval-fixture.test.ts:46-95`,
`codex/codex-rs/core/tests/suite/command_lifecycle_tests.rs:240-304`, and
`hermes-agent/tests/cron/test_cron_direct_api_call.py:49-80`.
The vendored `claude-code-src` snapshot was searched for deferred/barrier
concurrency tests and contained no matching test source. The correction
converges on those entry/release patterns.

## Solution

The reviewed correction is confined to
`back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts`.
Hold the incompatible fixture's create response until the contender answers,
then release it in `finally`. Before release, assert the exact incompatibility
error, that the first worker remains pending, and that its ledger remains
`STARTED`. Preserve the original success, rejection, one-create and one-hydration
assertions after release. Release again in fixture cleanup so failed checks do
not leave the local HTTP handler held. Ordinary and deliberately delayed
contenders run for both providers through the existing registered domain.

All 40 original assertion calls are retained, with three new calls. Their
normalized original AST SHA256 is
`25fbc3afe07fa7b6f55de8f579301bb0d58ecb6c25f692f76684f2b7d4643778`.
No production source, timeout, budget, provider configuration, credential or
schema changes. At 10,000 agents the production path and resource usage are
unchanged; the synchronization is only in the offline test fixture.

The permanent regression failed before the barrier correction, then the exact
same command passed five consecutive times, with 34 scenarios per run. Run
durations were 64, 77, 82, 71, 53 seconds. All four ordinary/delayed incompatibility
controls per run returned the exact expected rejection while the first worker
completed successfully with one create and one hydration. Full backend
`npx tsc --noEmit`, Prettier and `git diff --check` also passed. The exact native
command for the permanent red/green pair and all five runs is:

```bash
cd back-end
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_custody_rca_20261026 \
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_custody_rca_20261026 \
node --import tsx src/tests/blackbox/browser-session.blackbox.ts --resume-custody-only
```

The separate local database contains schema only copied from the existing local
coverage database. Each native fixture creates and cleans its UUID-owned rows.
No backend or production service was started. The registered browser-session
blackbox imports and invokes this function in full deploy coverage; `run.ts
--list` includes the owning domain. The parent owns full backend acceptance,
archive reindexing and deployment.

Final fixture source SHA256:
`946944f532098697d04644f6c1b0454963f8546b0b8784033eb1eefe80652c7b`.
Reviewed source diff SHA256:
`196349f0c0d78f49062f1997ea000325f764cdd7a616a0bd4abc27e29a9a984b`.
Verification receipts are `.context/rca-browser-custody/verification.json`; the
parent retains ownership of full deploy acceptance and shared-index refresh.

## Human feedback

The assignment required original native red evidence, unchanged assertions and
deadlines, coordinator review of the exact diff before mutation, a separate
owned local database and no production or other-worker changes. The coordinator
requested the exact incompatibility error and active-ledger/first-pending
observations, then approved the reviewed regression and barrier in stages.

## Reusable lesson

Hold the fixture operation until its intended contender has crossed the real admission boundary instead of assuming worker startup fits inside a timed overlap window.

## October 27 failure-path follow-up during main integration

Independent review of merged source4b1743934 found that the held owner promise
had no rejection observer while the contender was awaited. A controlled native
12-second contender startup exceeded the unchanged10-second owner deadline:
Node reported unhandledRejection and exited before fixture cleanup, leaving one
owned child, context/session and STARTED ledger. This schedule reproduces a
failure path; it does not establish the historical production/load schedule.

The fixture now immediately observes both operations with Promise.all while
retaining the exact incompatibility, pending-owner and STARTED assertions in
the contender task. Its finally still releases the owner. A registered
incompatible-owner-timeout scenario keeps the10-second deadline and12-second
fault input; only this explicit negative control expects the precise fixture
timeout error, joins both children and verifies server closure plus zero exact
context/session/ledger rows. Ordinary timeouts remain failures. All43 existing
assertion calls are unchanged, with six new expected-error/cleanup checks.

The same permanent control on old sequencing exited1 with unhandled rejection
and retained resources; corrected sequencing exited0 with34 ordinary cases and
two explicit expected-timeout controls, both providers reporting zero children
and rows before observer cleanup. No supervisor cleanup was needed after green.
Exact commands, source hashes and pre-cleanup receipts are retained under
.context/deploy-fresh-20261027/independent-review/ir1-native. This repair changes
only the test fixture; full combined coverage remains the deploy owner's gate.


## October 27 fresh-concurrent follow-up

The combined backend gate at source 8b1c38ff failed `creates === 1` with two
creates. Retained V8 coverage identifies Browser Use/fresh-concurrent (scenario
loop 15, Kernel branch 0). The historical worker timings were not captured.
The separate earlier incompatible-owner failure-path repair did not establish
this sibling fixture's intended overlap.

The unchanged fixture released create after 100 ms. Starting two child processes
does not prove both have joined active custody. A fresh request entering after
the first operation finishes correctly starts a new lifecycle. A controlled
native 2-second delay of only the second concurrently forked fresh worker
reproduced the same two-create assertion: the first completed at 01:38:40.589Z,
the second entered at 01:38:42.931Z and returned a distinct session. These are
controlled timings, not a recovered historical schedule.

The reviewed correction holds the first fresh create until the designated
contender's real Prisma query returns this exact operation's STARTED/creating
custody row. A fixture-only worker observer sends IPC and returns the actual
query result unchanged; no extra query or production change is introduced.
The fixture observes owner and contender immediately with Promise.all. A
permanent 1500 ms contender-start delay protects the slow-start boundary;
existing 10-second deadlines and all 49 assertion ASTs remain unchanged.
Fresh-sequential remains the negative sibling: both providers require two
creates, two hydrations and distinct sessions.

The native permanent control failed before and passed after with identical
argv, 34 ordinary scenarios plus both expected owner-timeout cleanup controls.
The controlled 2-second pair also failed before and passed after. All exact
UUID rows were independently absent, every native child exited, and no observer
kill or unhandled rejection was needed. Evidence and limits are retained under
`.context/deploy-fresh-20261027/rca-custody-create-count/`.

Applied patch SHA256:
`ab8bdd845c9132648e4d8ba9946f669f3e227f47872387fd6a1d75a69fe77250`.
Applied fixture SHA256:
`591a02d23b313d40239218eaf53473cfa11c18e5609ec32f21ba80a727bd5d0d`.
Applied worker SHA256:
`0953725628d0025ac9504d7cb669ddc41bcbe73a107f5b5c8d14f8ab82a39134`.
The coordinator applied the exact reviewed bytes. Full combined-source backend
coverage and deployment remain pending; the narrow native result does not
certify those gates.
