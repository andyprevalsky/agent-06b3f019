---
id: 2026-10-24-prelaunch-guest-cancel-unretirable
date: 2026-10-24
title: Fleet TERM during guest bootstrap left started guests that neither cleanup nor recovery could retire
surface: harness
component: cloudbench-boot-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-boot.sh honoured the durable /shutdown request only after the unbounded bootstrap fetch, and no runtime-evidence producer existed for a guest that stopped before launching its driver
symptoms:
  - guest did not acknowledge browser/session cleanup; retaining provider ownership
  - sealed runtime evidence could not be recaptured
  - "HTTP Error 409: runtime evidence is incomplete or changed"
  - exact guest quiescence rejected: guest driver state is not terminal or inspectable
  - shutdown requested before driver launch; cleanup acknowledged
tags:
  - cloudbench
  - cancellation
  - exact-owner-recovery
  - evidence-retention
  - boot-supervisor
sources:
  - fleet run 20261024-172230-25507 (campaign campaign-20261024-172214-21102, descend-full69-20261023; Machines 84eee54be0d608, 8d967dda943528, 683dd96da196d8, 8ee321b7e06d68)
  - commit 234bfce26 (fix), b415d0668 (fixture), 29698a5cb (source review entry) on rca/LEAK-cancel-during-bootstrap
repro: scripts/tests/cloudbench-prelaunch-cancel.test.py
status: mitigated
---

## Problem

The parent sent one TERM to a five-copy `test-mass-agent-run-0` campaign
about 80 s after start. Every fleet controller logged
`⚰️ controller received TERM (17:23:36)` immediately after the primaries
became provider-visible. The campaign exited `cancelled` (143), but four of
the five guest Machines stayed STARTED. Every fleet's
`_batch/disposable-cleanup.json` recorded `guest_cleanup_missing=true` and
`runtime_evidence_missing=true`.

Exact-owner recovery first refused with `guest driver state is not terminal
or inspectable`. Once the guests sealed themselves at 17:27:34–49, it refused
again with `sealed runtime evidence could not be recaptured`
(HTTP 409 `runtime evidence is incomplete or changed`).

Each guest's `bench.log` showed:
- `bootstrap-checkout` at 17:23:21
- `[cloudbench] git-fetch 220s` and `git-checkout 42s`
- `[boot 17:27:43] shutdown requested before driver launch; cleanup acknowledged`

There was no `repo/.context/cloudbench` directory: no driver, stack, browser
or provider session ever existed.

## Diagnosis

Two boundaries combined.

**1. Delayed acknowledgement.** `/shutdown` on the status server answers 202
during `booting` and relies on the boot supervisor to consume the durable
request. `cloudbench-boot.sh` checked it only after `bootstrap_checkout_ref`
returned, which here took about 260 s. The fleet waits
`CLOUDBENCH_CHILD_TERM_SECONDS` (30 s) for `/shutdown-health` 204, then
retains provider ownership.

**2. No evidence producer for a no-launch guest.** `runtime-evidence.pending`
is latched when the post-config start is accepted. It is cleared only by a
sealed full-stack bundle (`services.json`, `run.json`, worker logs) matched
to a run result. A guest that stopped before launch can never produce one. In
the TERM path, the controller therefore retained the guest even when the ack
did arrive. Recovery's recapture hit the same 409.

The only existing zero-credit "pre-service" startup archive admitted only
*rejected* starts (no `post-config-start.accepted`, exit 125).

Deepest owned cause: the guest lifecycle had a truthful terminal state ("stopped
before launch, cleanup acknowledged") that no runtime-evidence contract could
represent. Every consumer therefore classified it as incomplete forever.

Archive searches:
- `did not acknowledge browser/session cleanup retaining provider ownership`
  surfaced 2026-10-12 group-term-killed-guest-shutdown-proxy, a relative: the
  stop was delivered here, but not consumed in time.
- `cancel during startup bootstrap checkout shutdown request before driver
  launch runtime evidence pending` surfaced 2026-10-07
  failed-startup-cleanup-required-execution-seal, a relative: the same latch
  shape for rejected starts.

This is a novel instance of that class.

Local reproduction: `python3 scripts/tests/cloudbench-prelaunch-cancel.test.py`
on da22666f3 sources. It drives the real boot.sh, status server, both collectors
and the fleet validator, with a 240 s fake fetch. It fails with
`202 != 204 : guest did not acknowledge cleanup within the fleet window` and
eligibility `1 != 0`. With only fix (1), it fails at the collector with the
production error `guest shutdown without sealed runtime evidence`.

## Solution

**Guest-side fix (`scripts/cloudbench-boot.sh`, `scripts/cloudbench-status-server.py`).**
- `cloudbench-boot.sh` runs the bootstrap checkout in its own process group,
  polls the durable shutdown request and stops the checkout when the request
  arrives. The existing pre-launch path then acknowledges within about 1 s.
- Both no-launch paths write a token-bound
  `cloudbench-prelaunch-<token>.sealed` before the ACK.
- The status server serves that state as a `prelaunch` runtime-evidence
  manifest whose only file is the exact `bench.log`. It is refused if a driver
  PID exists.

**Controller-side fix (`scripts/cloudbench-collect-runtime-evidence.py`, `scripts/run-bench-cloud`, `scripts/run-bench-fleet`).**
- Both collectors accept that manifest, check the RUNSTAMP and release the
  latch, since no result can exist to bind it to.
- The fleet's final validator and the runtime-evidence recovery accept it
  without demanding a run result.

**Recovery for guests already running older sources (`scripts/cloudbench-startup-failure-archive.py`).**
- When recapture fails for an accepted start, recovery tries the existing
  pre-service startup archive.
- Its eligibility now admits a TERM-cancelled (exit 143) start accepted for
  that exact Machine.
- `verify()` requires the `pre-service` phase for any accepted start.

An adversarial review then tightened this route. An accepted start now qualifies only when no `repo/.context/cloudbench` original exists. A failed fallback capture is moved aside as preserved evidence, so it cannot block a later recovery plan. The run's source fingerprint `e7b8eafe…` (da22666f3) received an independent
read-only review and was granted `before-stack-launch` only.

**Outcome.**
- Regression red on da22666f3 and green 5/5 afterwards, registered as
  `cloudbench-prelaunch-cancel` in `scripts/run-deploy-structural-gates.py`.
- The live recovery of all four owners succeeded, one at a time. All four
  Machines are natively `destroyed`, their volumes are released and the
  registries are removed.

Status is `mitigated` until this is merged and deployed.

**10k-agent behaviour:** per-guest only. There is one 0.5 s file poll per
booting guest and no shared state.

**Golden reference:** `claude-code-src/src/utils/execFileNoThrowPortable.ts:9`
(an `abortSignal` on subprocess execution) and
`codex/codex-rs/core/src/exec.rs:155` (`Cancellation(CancellationToken)`)
both make long-running subprocesses cancellable rather than awaited to
completion. The fix converges on that pattern for the bootstrap fetch.

## Human feedback

None recorded. The parent coordinator approved plan (a)+(b) as infra and
directed recovery of the four owners through the fixed supported path.

## Reusable lesson

Every guest lifecycle state that a cancellation can produce must have a
truthful runtime-evidence and cleanup contract. Every long pre-launch step
must honour the durable stop request within the controller's
acknowledgement window.


### Regression 2026-10-27: launched-driver test observed lifecycle before HTTP readiness

The five-test `cloudbench-prelaunch-cancel` gate reported connection refused while asserting `/runtime-evidence == 409`, on `46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277`. The original log did not capture the status process's output/outcome, so the archived process's specific state remains unknown.

A controlled native reproduction delayed the real status-server process by 800 ms. The driver exited rc=0 and published `exited`; the test immediately requested runtime evidence while the separate server process was alive but had not bound its socket. No prelaunch seal existed. The original five-test native file failed with the same connection refusal, 3.614 s, and passed unchanged in assertions after the readiness correction, 3.828 s.

The first-bad boundary was the regression test equating a driver-state file with readiness of an independently scheduled HTTP process. Inside the existing 20-second startup deadline it now requires real `/driver-health == 410`, retrying only connection refusal before bind. The existing 409 runtime-evidence assertion, no-prelaunch-seal check, request timeout, polling cadence, and cleanup bounds remain intact. A subclass runs both original lifecycle cases with controlled delayed server startup. The permanent seven-test command fails before this correction (one matching connection-refused error, 5.812 s) and passes after it (7/7, 6.522 s). A real server exit-17 control still fails within the original startup deadline (20.662 s).

The earlier production lifecycle/evidence contract is preserved; this does not demonstrate that its fix recurred in production. The coordinator reviewed and applied the exact native-tested bytes (SHA256 `9be4b4d85a6579eaa428d81caf59335bdeeeab244307c6de0a8032c344075d4b`) after all batch-2 gates exited. Full combined-source acceptance and deployment remain pending. Exact diff/proof hashes and joined cleanup are in `.context/prelaunch-cancel-rca-20261027/`.
