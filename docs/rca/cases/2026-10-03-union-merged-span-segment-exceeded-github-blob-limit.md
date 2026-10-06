---
id: 2026-10-03-union-merged-span-segment-exceeded-github-blob-limit
date: 2026-10-03
title: Every branch appended span rows to the same dated segment, so union-merging main produced a 133.55 MiB ledger that GitHub rejected on push
surface: infra
component: benchmark-history-ledgers
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/span_history.py `_append_history_path` named rollover segments only by date, so every writer shared `span_durations.<date>[.NN].jsonl`; the 90 MiB cap is checked per writer, but `merge=union` concatenates both writers' rows
symptoms:
  - "File agents/benchmarks/history/span_durations.20261002.jsonl is 133.55 MB; this exceeds GitHub's file size limit of 100.00 MB"
  - "pre-receive hook declined"
tags:
  - git-merge
  - benchmark-history
  - github-blob-limit
  - deploy-gate
sources:
  - PR #1341
repro: span-history blackbox `branches_roll_into_separate_segments` records on two branches of a temp git repo with the cap at 1 byte; before the fix both land in `span_durations.<date>[.NN].jsonl`, after it each branch gets its own segment. `history_ledgers_fit_github_blob_limit` flags any ledger at or over 100 MiB (the merge commit 701869867 had a 140,038,959-byte segment).
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, this branch merged `main` again
(local merge `701869867`, never pushed). Pushing it failed: GitHub rejected
`span_durations.20261002.jsonl` at 133.55 MiB. `span_durations.20261001.02.jsonl`
was 97 MiB, close behind.

## Diagnosis

### Evidence

- Blob sizes for `span_durations.20261002.jsonl`: `main` 98,660,713 bytes, this
  branch before the merge 99,464,825, merge `701869867` 140,038,959. For
  `span_durations.20261001.02.jsonl`: 92,945,257, 94,347,547, and 101,862,457.
  Each side was under GitHub's 100 MiB limit. The union was not.
- Both sides started from the same base content, then each appended its own
  deploy rows. `merge=union` (added by
  `2026-10-02-dated-span-history-segments-not-union-merged`) keeps both tails.
  Repeated syncs had also duplicated about 68k rows in the 20261002 union.
- `_append_history_path` checks `MAX_HISTORY_FILE_BYTES` only against the
  local file at append time, and every checkout picks the same name for the
  same day.

### Root cause

The rollover contract assumed one writer per segment. Several branches write
the same dated segment, and once union merge was enabled, the size cap held per
writer but not for the merge result.

## Solution

`_append_history_path` now adds the checkout's branch slug to rollover names:
`span_durations.<date>.<branch>[.NN].jsonl`. Detached or non-git checkouts keep
the plain dated name. Each branch appends only to its own segments, so a merge
takes one side's tail unchanged instead of concatenating two.
`.gitattributes` still covers these names through `span_durations.*.jsonl`.

This branch's unpushed merge was redone locally: the shared segments are
`main`'s exact blobs, and this branch's extra rows moved into
`span_durations.<date>.cursor-write-lock-resend-id-false-positive-b096.jsonl`.
The remote branch was never rewritten.

The span-history blackbox gained two cases:

- `branches_roll_into_separate_segments` failed before the fix (both branches
  wrote `span_durations.<date>.jsonl` and `.02` / `.03`) and passes after.
- `history_ledgers_fit_github_blob_limit` fails if any ledger is at or over
  100 MiB, so a union that GitHub would reject fails locally before the push.

## Human feedback

None recorded.

## Reusable lesson

A size cap that is checked by each writer does not bound a union merge of
several writers. When append-only files are union-merged, give each writer its
own file. Then the merge never concatenates two tails, and each writer's cap
still holds after the merge.
