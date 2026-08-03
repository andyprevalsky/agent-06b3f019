---
id: 2026-07-20-full-cookie-corpus-sync-exceeds-the-credential-budget
date: 2026-07-20
title: Per-row syncing of all 22064 cookies takes ~780s against a 420s credential-sync cap, so every logged-in browser task CHILDFAILs
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: "run_benchmark.py:_sync_browser_credentials — 420s cap around seed-local.ts --credentials-only, which per-row upserts the entire Cookie table"
symptoms:
  - "Live fixture could not refresh complete browser auth state"
  - all agents CHILDFAIL at ~433–457s into the run
  - "seed-local.ts --credentials-only exits non-zero at the 420s timeout"
  - fails even at low neighbour concurrency, so it is not contention
tags:
  - benchmarks
  - browser-credentials
  - cookies
  - timeout
  - bulk-insert
sources:
  - memory:project_ecommerce_slice_compute_token_gate
repro: none-recorded
status: open
---

## Problem

With the boot layer clean (8/8 reaching the start barrier), all 8 ecommerce agents
CHILDFAILed at ~433–457s — `_sync_browser_credentials()` hitting its 420s cap with
`Live fixture could not refresh complete browser auth state`.
`seed-local.ts --credentials-only` does a FULL sync of all **22064 cookies** via
per-row upsert at concurrency 8
(`seed-local-credentials.ts:syncCookieCredentials`), measured at ~780s — inherently
over budget. It reproduced at neighbour=5, proving it is not contention.

## Diagnosis

The warm-restore fix EXPOSED this rather than causing it: warm-restored boxes skip
`run.sh`'s boot credential sync (`DB_RESTORED`), so `run_benchmark` performs the
full sync inside its own 420s window instead of inheriting an already-synced DB.
The deeper cause is that the credential fixture is corpus-wide and row-at-a-time —
every task pays for every cookie in the account regardless of the domains it will
visit — so the work is O(all credentials) while the budget was sized for a
warm-start delta.

## Solution

Not yet built; two fixes approved by the human. (1) Speed: bulk `createMany` on a
fresh box instead of 22k per-row upserts. (2) Selection: `Cookie` has `domain` plus
`@@index([userId, domain])`, so a task declares the domains it needs
(doordash → doordash.com) and syncs ~100 rows instead of 22064 — seconds, not
minutes; generic tasks with no declared domains sync everything under a raised
budget. Note the budget raise alone was explicitly not accepted as the fix.

## Human feedback

The human approved the two fixes above and framed them as the required direction —
make the sync fast and per-task selective — rather than raising the cap, which
would have been the reward-hacking shortcut. Contrast with the compute-token gate
in the same session, where bypass WAS correct because gpt_code was not needed;
browser auth IS required by these tasks, so it must be made robust, not skipped.

## Reusable lesson

Size fixture work to the task, not to the account — a corpus-wide per-row
credential sync will always outgrow a per-run timeout, so select by the declared
domains and bulk-insert.
