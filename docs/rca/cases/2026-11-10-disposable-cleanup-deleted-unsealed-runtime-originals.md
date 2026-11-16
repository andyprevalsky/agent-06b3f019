---
id: 2026-11-10-disposable-cleanup-deleted-unsealed-runtime-originals
date: 2026-11-10
title: Disposable cleanup deleted original runtime sources before evidence was sealed
surface: harness
component: cloudbench-fleet-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup left KEEP_CLONES false after final runtime collection failed for a disposable registry and entered Machine and Volume destruction
symptoms:
  - "runtime evidence is incomplete; failed result retained while disposable resources are retired"
  - "runtime-evidence-unconfirmed"
  - "guest-shutdown.confirmed exists but runtime-evidence.pending remains"
tags:
  - cloudbench
  - retention
  - runtime-evidence
  - disposable
sources:
  - PR #1865 smoke attempt42
  - commit 431b7c4cb2aff2af425c95d0f2aedd658e843b9c
  - commit f8c8255003d70ac639facf623b30397d62baf38a (upstream)
repro: scripts/tests/cloudbench-disposable-lifecycle.test.py final-unsealed/mixed and failed-worker tests; original cleanup decisions delete uncaptured originals, candidate owning file passes30tests
status: open
---

## Problem

Native smoke42 left three tasks without a sealed original runtime: payment shop,
payment setup/resume and browser biometrics. Each had runtime-evidence.pending,
a bound runtime owner and an admitted configured guest, with no canonical run
or sealed runtime run. Shop and biometrics had a guest shutdown ACK; setup did
not. Their controllers nevertheless printed the disposable-retirement message,
then destroyed each exact original Machine and sent its Volume DELETE. Native
audits record destroyed-provider-retained; the three original Volumes became
soft-deleted without a source snapshot. This repair cannot recover or certify
preservation of those originals. The coordinator owns a separate one-shot
non-destructive recovery investigation, with its real refusals retained.

## Diagnosis

Gate: NOT_INTRODUCED. The exact failing cleanup decision is byte-identical on
431b7c4 and upstream f8c825 (SHA2565c85e830ee2639c8a7f18551f9a7f4e32e7fb9ffa1f267203a2a1a5d8ec713f6).
The cloudbench retirement and October7 mixed-cohort cases were searched/read.
Those preserve valid sealed normal history; they do not authorize destroying an
unsealed source because a guest ACK exists.

The final collector correctly returned failure, but cleanup explicitly exempted
a valid disposable registry from KEEP_CLONES retention. It retained a failure
flag while the native reaper bypassed aggregate unconfirmed latches for current
disposable cleanup. Thus the first bad decision preceded the later forensic
capture refusal: the original stopped attached pair was already gone. Guest
shutdown and complete copied runtime are independent receipts.

## Solution

On final collection failure set KEEP_CLONES=1 unconditionally, retain the runtime
failure and teardown failure, and use the existing bounded exact-owner
billing-only stop path after positive producer joins. Keep every original
registry/audit/claim/latch and attached volume. If billing-stop authority is
unconfirmed, preserve the existing fail-closed pending result rather than
fabricating STOPPED or allowing destruction.

Final cleanup and the failed-worker staging refusal change. The earlier worker
cleanup path had the same disposable exemption: it set runtime_missing but
left rc=0, destroyed the worker and released its exact teardown handle, then
returned failure after data loss. The same owning function is byte-identical
on431 and actual upstreamf8 (SHA256 2ad5f0eec0605a680cd851d9cd63734e27d90748c55be6a0621050c2eaf6f439).
The unchanged full mocked controller exposed this second route under falling
demand; the correctly strict retained-owner assertion observed a missing worker.
The corrected branch sets rc=1 for every lifecycle before any reap or release.
Four actual-function controls are RED only for the old disposable-unsealed case,
then GREEN for the candidate: unsealed legacy/disposable retain their pending
handle, while preserved sealed/unlaunched workers still retire normally. The
whole expanded owning lifecycle suite passes30tests in8.110s. The later full mocked owning controller completed at2026-11-10T22:43:02.322228Z
with native process exit0, all16 scenarios and final own-process retirement
assertions PASS (controller-full-root-20261110T2218Z.log). This is local mocked
controller regression evidence, not applied-source native smoke or gate acceptance.

The other current native reaper
entry is the early sealed-primary path, whose exact runtime/worker/native-index
guards remain unchanged. Recovery still needs the existing verified forensic
proof to consume the evidence latch before deletion. Normal sealed cleanup,
October7 mixed-cohort verifier/builder and all financial/cleanup truth remain
unchanged; no archive, guest ACK or PASS is manufactured.

The exact old branch reproduces three failed subcases: pending runtime after a
positive guest ACK, pending runtime without ACK, and retained mixed history.
The initial final-cleanup candidate passed26tests in7.430s, including all23
original test bodies byte-for-byte plus three new tests; the later worker-route
repair expands this to30tests with the four controls above.
The unchanged mixed forensic verifier/builder controls pass52tests in19.15s.
Both shell files pass bash syntax checks. An initial malformed extraction-only
harness error is retained separately and is not counted as the causal RED.

The full mocked controller fixture previously required destruction after an
unsealed failure. Its necessary contract correction retains native verdicts,
protected warm-resource assertions and original destruction assertions for
already-sealed normally retired history. Active unsealed rows must instead be
owned, stopped, attached to the exact original volume, and absent from every
Machine/Volume DELETE call. Only after those stronger assertions and a private
fixture-state copy does test-only reset remove its own fake state. The acknowledged-shutdown case now distinguishes its unchanged guest shutdown
authority from a later billing-only stop: the latter must have exact native
quiescence/source receipts, retain config and attached Volume, and grant no
evidence, release or task credit. A still-draining live guest still forbids
every native stop. The fake provider models only the existing source/nonce-bound
idle probe and checks the real fixture-driver PID/birth has terminated; it never
ACKs a live or reused driver. No test budgets, unrelated assertions, production
verifiers or runtime ownership protocols are weakened. Full owning-controller outcome is recorded separately;
actual applied-source/native smoke acceptance remains pending.

Golden reference: not applicable; this is harness retention and test-fixture
contract correction, with no model-visible prompt edit.

## Human feedback

The actual user requested finishing /deploy and preserves Freedom. The
coordinator required external-only prevention work and explicitly prohibited
claiming that this fix preserved the three already-deleted original volumes.
These coordinator constraints are not invented direct user feedback.

## Reusable lesson

A failed-result flag does not preserve evidence after its source is deleted.
Retain the exact original pair until a sealed normal or admitted forensic proof
exists; treat guest cleanup ACK and runtime preservation as separate contracts.
