---
id: 2026-11-11-autoscaler-idle-sleep-delayed-child-finalization
date: 2026-11-11
title: Autoscaler idle sleep delayed already-published child completion
surface: infra
component: cloudbench-autoscaler
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: bench_autoscaler sleeps through benchmark-child.finished publication before reaching its existing terminal reconciler
symptoms:
  - terminal publication waited for idle poll instead of finalization
  - cloudbench-multi-workstream.test.sh 0/5 1200s
  - controller-phantom-aged.log START without END
  - UNVERIFIED
tags:
  - autoscaler
  - terminal
  - latency
  - child-lifecycle
sources:
  - PR #1881
  - commit 6ec73775eb17e051cb64c1d0153968596c2a94c9
  - task GitHub Actions 42956070487
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: open
---

## Problem

The assigned whole multi-workstream unit still times out at1200 seconds with0/5. Actual6ec native phase evidence contains47 complete controller intervals and a final unmatched scenario15 aged-phantom call. It does not include child-marker publication timestamps, so the fraction of total runtime attributable to this latency is unknown. The original full five-repeat workload remains mandatory and this case grants no waiver.

A narrower real-time reproduction shows avoidable terminal latency: after the actual run_fleet_child_supervised producer joins a completed runner and atomically publishes benchmark-child.finished, the autoscaler can remain in its ordinary ten-second idle sleep. The final identical local reproduction took9.932109 seconds from publication to finalization; the five unchanged candidate observations ranged from0.134653 to0.138535 seconds. These are local boundary measurements, not full-suite speedups.

## Diagnosis

The autoscaler's loop head already checks the exact child-finished path before metrics or capacity decisions and calls complete_autoscaler_after_child. The normal loop tail unconditionally sleeps AUTOSCALE_POLL, currently10 seconds. A terminal publication just after that sleep starts cannot be acted on until it ends, although terminal reconciliation requires no further metrics poll.

The existing producer remains the authority: it waits for the real runner, handles residual process groups, preserves exit status and atomically renames the finished marker. The completion helper remains the arbiter: it reconciles ready/failed worker outcomes, waits for committed pending workers, preserves failure state and copies the original child status only after invariants settle. No new notification or marker authority is needed.

## Solution

External candidate: replace only the normal loop-tail sleep child with one transient standard-library waiter. It observes only the same local child-finished path, under the full original real monotonic poll deadline, at a bounded local stat rate. A missing or unreadable observation continues waiting. Ordinary timeout advances to the next normal metrics tick. A terminal observation calls the unchanged completion helper directly and returns its status; if the marker disappears, the original helper fails closed instead of advancing metrics early. Unexpected waiter failure also fails closed.

There is no FIFO, signal, new artifact, extra provider request, changed metrics cadence, shorter retry, changed finalization budget or new completion claim. Exceptional retry sleeps and the held-after-ready branch remain unchanged. The transient waiter occupies the slot of the previous sleep child; local CPU cost is measured in the private proof.

The owning regression executes the actual producer, the actual unchanged completion helper and the actual wait block. Controls cover the full no-marker ten-second interval, foreign-path and nonterminal hints, transient and persistent stat errors, disappearing observations, failed child status, worker failure, pending-worker drain and process-group TERM/KILL with native supervisor cleanup. Five unchanged focused repetitions and the full existing owning suite passed, alongside the actual f8 sleep ratchet and direct structural registration. The original whole1200/five/eight native acceptance is still pending; no200-second aggregate benefit is asserted from50 phase calls.

### Pre-integration dependency correction

The first external candidate was not integrated. Independent review found that existing extracted autoscaler fixtures require AUTOSCALE_POLL=0, and that their shared extractor did not bundle the new waiter. The corrected candidate preserves zero as a valid immediate interval, checks the terminal predicate first, and includes the waiter when extracting bench_autoscaler. The directly registered fixture-process-cleanup suite exercises the actual shared extractor and covers both requirements; the existing zero, runtime-handoff and worker-qualification tests run unchanged. These are integration fixes to the proposed patch, not new native outcomes. The original waiter candidate and its partial proofs remain historical.

## Human feedback

The parent rejected clock-skipping and mutable synthetic authority schemes, required a genuine terminal-only wake through the original completion helper, and prohibited earlier metrics/capacity ticks or weakened ownership and retry rules. The approved prototype uses a bounded transient waiter with real time and the existing marker; it remains external until harsh independent review.

## Reusable lesson

Let an already-authoritative terminal event end an idle polling wait while leaving the normal polling deadline and the full terminal reconciler unchanged.
