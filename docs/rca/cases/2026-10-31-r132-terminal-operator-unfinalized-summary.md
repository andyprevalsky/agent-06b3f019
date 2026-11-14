---
id: 2026-10-31-r132-terminal-operator-unfinalized-summary
date: 2026-10-31
title: Terminal campaign operator remained RUNNING in the scorecard
surface: harness
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_campaign used only summary.finished_at and ignored the separately recorded operator end
symptoms:
  - Original summary remained running after the operator exited
  - Existing run directory hid ledger end information in history
  - Four unstarted jobs remained queued in the unfinished summary
tags:
  - r132
  - reporting
  - operator-end
  - history
sources:
  - commit 691b9059a9ca3b41552be9679d712b50edcf24d5
  - benchmark run campaign-20261030-213323-299427
repro: Same original summary and terminal process receipt render RUNNING on baseline and labelled FAILED with summary_finalized false on the candidate
status: fixed
---

## Problem

The It30 operator exited1 at1793400604.9898357 after the later archive write
failed with ENOSPC. Its original summary still says running with no finished_at.
The scorecard therefore displayed RUNNING for an ended operator. This is a
reporting defect, separate from the native task failure and archive failure.

## Diagnosis

Exact load_campaign sets an end only from summary.finished_at. build reloads
an existing campaign directory for historical rows instead of falling back to
the experiments ledger. Recording a ledger end alone cannot fix either display.
The original process receipt binds source691b, PID299427/birth24944008, the
20-job command and exit1; it does not finalize the campaign summary or any job.

## Solution

The two-file candidate
`0c535e8c42150535061e2cefaf7329275e1ad706ba3bc9a794c5550e541638f8` adds an explicit hash-bound operator-end input to
the canonical scorecard. It validates summary and raw process hashes, campaign,
source, PID/birth/boot, clocks and command scope. Current and historical loads
use the same validated evidence. Nonzero exit displays FAILED; zero exit with
an unfinished summary displays INCOMPLETE. Both visibly retain “summary
unfinalized” and set summary_finalized=false. A finalized summary cannot be
overridden through this input. No original summary, ledger, job or lifecycle
receipt is written.

The same original replay changes only the operator-end display and clock:
9PASS,6agentFAIL,1INFRA,4queued remain unchanged;16 jobs are terminal and15
are scored. No queued job is declared cancelled, no grade is promoted, and no
resource release follows from operator exit. The process receipt is a supplied
custodian observation; byte hashes are not signatures or new live process proof.

## Validation

Five permanent methods run in the existing registered scorecard suite. They
cover current HTML/text, history, zero-exit incomplete, finished-summary priority,
changed hashes, foreign campaign/source/PID, missing birth/boot, invalid/future
end, command/count mismatch, duplicate inputs and canonical CLI refusal.
Independent review of V1 found missing operator qualification in plain-text
history. V2 adds the same explicit qualification and a permanent historical
text assertion; the assertion fails on V1 and passes on V2.
Full candidate suite76PASS; unchanged baseline71PASS. The original canonical
build replay is RED on baseline and GREEN on candidate, with byte-identical
summary and identical job accounting. Independent review qualified the exact
V2 snapshot after reproducing V1 RED / V2 GREEN and all76 passing tests.
The coordinator applied the exact qualified snapshot and reran all76 tests
(PASS in4.246s), the original replay and diff check. No live operation is inferred.

## Human feedback

The standing reporting requirements preserve original observations and clocks;
operator termination must not invent a finalized summary, job verdict or release.

## Remaining limits

The original task failure and later archive failure remain separate RCA scopes.
No new benchmark, provider call, recovery, task outcome or resource proof was
produced by this reporting change.

## Reusable lesson

Represent operator termination and summary finalization as separate facts. A
verified terminal process can close the reporting clock without completing
missing task records or granting resource-release credit.
