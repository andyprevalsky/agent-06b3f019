---
id: 2026-10-05-copy-campaign-duplicated-native-inventory-publishers
date: 2026-10-05
title: Repeated task campaigns duplicated the fleet native inventory publisher
surface: infra
component: benchmark-campaign-inventory
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-campaign created an independent app-wide native inventory publisher in each one-task fleet
symptoms:
  - fifty one-task controllers issue fifty Machines and Volumes inventory streams
  - native Machine list contains 19.9 MB of decoded JSON dominated by inline config files
  - first-child ownership cannot safely govern a feed borrowed by later campaign children
tags:
  - cloudbench
  - campaign
  - inventory
  - startup
  - ownership
sources:
  - PR #1299
  - commit 436844eb8c70e9e2fd15e1f6e33c01cedee75111
  - agent /root/demo_cache_integrity owning reproduction and independent review
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: fixed
---

## Problem

The requested fifty-copy cached diagnostic uses fifty independent one-task fleet
controllers. The existing keyed inventory shared hot polling within each fleet,
but each campaign child still created its own app-wide native Machines/Volumes
publisher. One actual read-only native Machines query took 2.108 seconds and
returned 19,906,688 decoded JSON bytes; inline `config.files` accounted for
19,644,566 bytes, or 98.7%. These are decoded CLI bytes, not measured network wire
bytes: source files compress well. The observation locates duplicated API and
JSON work; it does not establish that this mechanism caused an earlier long cloud
stage or that removing it supplies a measured cloud E2E speedup.

## Diagnosis

Archive searches for shared inventory, inventory polling, Machines rate limits
and inline payloads found source snapshot ownership, compressed boot payload and
clone-source observation cases. They supplied ownership and generation leads;
none substitutes for a failing reproduction of campaign-wide publisher reuse.

The owning reproduction executes the real campaign scheduler and existing
inventory producer, keyed reader, refresh lock and cleanup at a controlled Fly
transport boundary. Two ordinary consumers perform four initial/first-loop
Machines reads; parent sharing performs two. With the actual captured native
payload, the ordinary path transported 79,626,752 decoded Machine bytes and the
shared path 39,813,376. That is a 50% two-consumer mechanism reduction. The short
controlled fixture was 0.797 seconds ordinary versus 1.564 seconds shared because
joining the parent auxiliary loop adds a one-second stop-watch wait. Neither
fixture timing is a cloud benchmark measurement or a network-byte saving claim.

The original-source controls fail publisher sharing, post-mutation refresh call
count and dead-publisher campaign ownership; the unchanged credential and
production-only inverses preserve existing CLI behavior. Fresh capacity admission,
primary-start accounting and exact post-mutation resource reads must remain
native. A snapshot generation cannot establish a mutation receipt or forgive a
resource that remains live.

## Solution

Extract the existing producer into one shell library used by both the fleet and
campaign publisher. The unchanged Fly credential resolver and PATH fallback are
shared as well. A multi-controller cloud campaign captures that small source
cohort privately and owns one auxiliary publisher until all waitable child
controllers have finished cleanup. All-production-only campaigns retain their
existing controller-local path and create no shared Fly feed. A standalone fleet
retains its existing publisher and cleanup behavior.

Borrowers verify the app, publisher token and exact initial process birth
identities, read the same atomic keyed generation, and never terminate the
publisher or unlink its FIFO. The existing live publisher/token/finite-expiry
checks and bounded native retry remain. Explicit generation refreshes still use
the original recoverable atomic lock and native producer; native capacity
admission and exact resource mutation/teardown checks are unchanged. Process death
fails closed rather than inventing a new PID behind a child's sealed attribution
or multiplying fallback RPCs.

If the shared publisher dies, write the existing cohort abort first, then issue
one TERM to the exact waitable controller roots. Their normal EXIT handlers own
resource cleanup, which the parent polls and joins. This path adds no short
KILL escalation or harness deadline. Publisher failure also reaches the final
failed campaign summary, including when first noticed while joining the feed.
Malformed section budgets are parsed before spawning a publisher. User-signal
cancellation retains its existing behavior; the shared feed is stopped only
after child processes are joined.

Five compact offline controls cover two consumers and borrower cleanup, a
paused-before-gate publisher-death case with terminal summary and cleanup,
post-mutation native refresh plus standalone ownership, existing credential
precedence, and the production-only inverse. The unchanged final selection is
**3 failed, 2 passed in 4.10 seconds** on original source and **5 passed in
8.47 seconds** with the fix. Existing source-contract controls
resolve the actual sourced library rather than assuming these functions remain
inline. The new file and existing snapshot copy owner are registered in the
compact deploy wrapper. Independent review approved the source and executed
16 focused controls in 20.72 seconds before the final paused-startup addition;
the final paused-startup owning selection is **5 passed in 8.47 seconds**,
and independent final review approved source and archive with **5 passed in
8.51 seconds**.

Private receipts are under `.context/acceptance/cli-preflight-prototype/`:
`native-inventory.safe.json`, `campaign-inventory-native-transport.safe.json`,
`campaign-inventory-function-equivalence.safe.json`, and owning red/green logs.
The actual token resolver, timeout, refresh lock, native generation refresh,
primary-start accounting, registry native reads, Machine reap and pool native
state functions are byte-equivalent to the original source. No raw provider JSON,
configured env, forensic captures or secrets are stored in this archive.

## Human feedback

Prioritize large measured startup stages, keep CLI improvements reusable by future
agents, preserve genuine benchmark outcomes and allow interruption at deployable
checkpoints. No task definitions, prompts, models, evaluators, harness execution
windows or cache identities change. This is a shared read-only infrastructure
optimization, not new mandatory benchmark rejection verification. The cached
performance experiment continues to earn zero LIVE acceptance credit, and actual
cloud width, terminal outcomes, resource closure and E2E timing remain unproved
until the separate live run supplies them.

## Reusable lesson

An O(1) provider feed inside each controller becomes O(number of controllers)
when a scheduler repeats the controllers. Share only bounded read-only
observations at the scheduler lifetime, while preserving exact owning mutation
checks and borrower cleanup fences. Count actual native calls and decoded work,
and report measured cloud E2E independently instead of converting transport
reduction into a fabricated speedup.
