---
id: 2026-10-02-treasury-rails-unused-mint-transfer-stayed-consumed-past-deadline
date: 2026-10-02
title: treasury-rails timed out because AgentCard kept an unused card's mint transfer `consumed` for 4 minutes after close, even after its residual was recovered
surface: back-end
component: treasury-rails-blackbox
classification: third-party-failure
problem_class: other
first_bad_boundary: AgentCard sandbox org wallet — the closed card's mint transfer `owt_…` for card_0a398f4b38448e35214fd361 never left `consumed` within the 240s settle wait
symptoms:
  - "unused mint never reclaimed after 25 attempts; transfer for card_0a398f4b38448e35214fd361: {\"status\":\"consumed\",\"releasedCents\":0,\"transferredCents\":1300}"
  - "treasury-rails blackbox FAILED: transfer for card_… ended in \"consumed\" — an unused card must reclaim/release, not stay consumed"
tags:
  - agentcard
  - treasury-rails
  - sandbox
  - settlement-latency
  - deploy-gate
sources:
  - PR #1341
repro: bash back-end/scripts/run-blackbox-tests.sh treasury-rails
status: open
---

## Problem

`/deploy` Step 4a (deploy run `20261001-145844-51013`, HEAD `78ff3dddb`, stage
log `backend-coverage-blackbox-20261002-173142-1368612.log`) failed 1 of 170
backend blackbox domains. `treasury-rails` minted a $13.00 card from the pool,
closed it unused at about 17:35:50, and then polled for 240s. The card's mint
transfer stayed `consumed` with `released_cents: 0` on all 25 attempts.

## Diagnosis

### Evidence

- The test's own residual sweep recovered exactly $13.00 at 17:38:51, about 3
  minutes after close. In passing runs the residual comes back within about
  100s, and the transfer flips to `reclaimed` on the next poll. Here it did not
  flip in the remaining minute before the deadline.
- The 13 earlier coverage runs of this domain on this branch passed in 139–193s.
  This run took 260s, the full settle deadline.
- No AgentCard throttle or transient-unavailable result appears in the domain
  log. The host was not under pressure (`host-pressure.log`: cpu some
  avg10=0.22, 9.6 GB available).
- The isolated backend and the Step 5 stack made no AgentCard mint, close, or
  recovery calls in that window. The Step 5 stack logged only the once-a-minute
  wallet-monitor warning.
- A standalone rerun on the same HEAD passed in 147s and reclaimed on attempt 13.

### Root cause

AgentCard's settlement of a closed card's mint transfer was slower than the
240s wait allows. The residual took about 3 minutes to become recoverable, and
the transfer had still not flipped a minute after recovery.

Not ruled out: another AgentCard blackbox domain running at the same time
(`domainConcurrency=4`) could have minted on the same shared sandbox cardholder
and netted against this card's released residual. That is the
"mint against existing residual" path documented in `sweepResidualHeadroom`.
The suite writes every domain log at the end, so this run's per-domain timing
can't be recovered. This was not reproduced.

## Solution

On timeout, `waitForUnusedMintSettled` now prints AgentCard's full transfer row
for the card (`substatus`, `kind`, `failure_reason`, timestamps) and every
attempt's `recover_funds` yield. The next occurrence then shows whether the
residual was ever recovered for this card and what state AgentCard reports.
This was checked with a forced 20s deadline.

The 240s deadline is unchanged.

Still open:
- If the provider row shows `substatus` stuck after recovery, report it to
  AgentCard.
- If it shows netting against a concurrent mint, give this domain its own
  cardholder or make it exclusive with the other AgentCard minting domains.

## Human feedback

None recorded.

## Reusable lesson

A test that waits on a shared third-party ledger needs to log the provider's
own record of the object it waits on. A summary of a few fields cannot tell a
slow provider from a concurrent consumer.
