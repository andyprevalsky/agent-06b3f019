---
id: 2026-10-16-retained-controller-cold-handoff-endpoint
date: 2026-10-16
title: Cold handoff endpoints omitted verified retained controller continuations
surface: infra
component: cloudbench-controller-export
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: cold handoff endpoint capture admitted only temporary inert maintenance init
symptoms:
  - "handoff endpoint is not exact inert maintenance controller"
  - "retained endpoint has active controller writers"
tags:
  - cloudbench
  - retained-controller
  - ownership
sources:
  - PR #1525
repro: scripts/tests/cloudbench-bootstrap-recovery.test.py RetainedControllerEndpointTests
status: open
---

## Problem

The cold-primary handoff endpoint accepted only a temporary maintenance init.
The retained controller continuation deliberately preserves its original init,
physical roots and ownership. The two valid contracts could not be composed
without replacing the preserved init, so a retained destination remained
ineligible for the existing handoff workflow.

## Diagnosis

The owning registered reproduction submits the retained init to the existing
endpoint validator and fails with its exact refusal. Controller continuation
already verifies the old export, original live init, new driver, same roots and
ownership. The missing component was endpoint admission consuming that proof,
not a looser native-config allowlist or copied owner metadata.

## Solution

A separate source-bound endpoint module composes the existing continuation with
fresh native Machine/Volume observations. It requires a hash-bound authentic
original native config/instance, unchanged current config, original init argv,
new driver ancestry, unchanged physical roots and ownership. It invokes the
same canonical writer/owner predicate as controller export. Only the verifier,
new driver and original init may be permitted; descendants remain subject to
normal writer checks.

The fleet snapshots and source-checks this separate dispatcher for requests
that explicitly provide retained-controller evidence. Ordinary inert endpoint
handling remains unchanged. The current-primary guest collector file remains
byte-for-byte unchanged, preserving existing source-bound guest captures.

Tests cover the endpoint refusal and identical RED-to-GREEN source transition,
wrong init/source/roots/config, stale native baseline, non-ancestor driver and
active writers. Process and provider boundaries are mocked; filesystem custody
is real. No native operation or eligible destination is claimed by these tests.

Operational prerequisites remain open: an authentic original native baseline,
the final immutable runtime source, fresh exact native observations and a
passing actual writer guard. A current native receipt cannot be renamed into
historical evidence. The driver must exec the fleet so an unpermitted
intermediary does not retain the checkout. No pre-first-use source rebind was
added; imported primary proofs retain their exact destination source contract.

## Human feedback

The user requires Machine/data/warm/Freedom preservation and no blind creates.
The coordinator specifically required preserving the original init and guest
collector bytes, reusing the canonical writer predicate, and making no native
calls during implementation. An old idle child is not exempted from that
predicate.

## Reusable lesson

Compose retained execution custody with endpoint admission through its verified continuation rather than replacing protected initialization or weakening idle checks.
