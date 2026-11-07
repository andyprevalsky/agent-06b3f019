---
id: 2026-11-06-code-session-checkpoint-restored-the-unchanged-git-tree-until-the-repo-outgrew-the-cap
date: 2026-11-06
title: Every Rose-repo code session close failed its checkpoint because worktree.tar.gz re-stored the unchanged git tree and the repo outgrew the per-artifact cap
surface: back-end
component: back-end/src/providers/codeSessions/checkpoint.ts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: checkpoint.ts createCheckpoint tarred the whole sandbox HOME into worktree.tar.gz, including every tracked file unchanged since HEAD that restore can rebuild from the repo, so the artifact size scaled with the repo (Rose ~208 MB compressed) instead of with the session's own state, against a fixed 200 MiB cap
symptoms:
  - "Checkpoint worktree is 210456698 bytes (cap 209715200); refusing to store"
  - "Code session checkpoint failed codeSessionId=158b5aa5-496e-456f-b757-2df23dcfcc74 reason=close"
  - close checkpoint of a code session that holds the Rose repo takes ~28 s and then fails silently (close still returns 200 and the sandbox pauses)
  - Checkpoint stored ... bytes=208218496 (Rose checkout checkpoints sit within 1% of the artifact cap)
tags:
  - code-sessions
  - checkpoint
  - artifact-cap
  - rose-repo
  - repo-size
  - benchmark-history-ledgers
sources:
  - commit eb3be2d0f (fix + regression)
  - commit d42b7d848 (code_agent_checkpoint_stored benchmark check)
  - agent ff45713e-9fcd-4d42-9c92-86df519a0462
  - fleet run 1793997299-2151896-48970
repro: back-end/src/tests/blackbox/code-sessions-checkpoint-size.cases.ts
status: fixed
---

## Problem

Every close of a code session that holds the Rose repo logs `Code session checkpoint
failed ... error=Checkpoint worktree is 210456698 bytes (cap 209715200); refusing to
store`. Close is best-effort (it logs, returns null, still pauses the sandbox), so no
caller sees it: the run just has no durable checkpoint, which breaks the fallback
resume and the handoff of a session whose paused sandbox is gone.

Evidence. The code-agent-rose-repo benchmark stored 208,218,496 / 208,209,555 /
208,214,663 bytes at 14:32-14:55Z, then failed five times in one run at 20:41-20:57Z
at 210,451,937-210,461,030 bytes (stack 1793997299-2151896-48970, ERROR
CodeSessionLifecycle lines, each preceded by a ~28 s tar). Production was one commit
away: its two Rose-repo checkpoints on 2026-11-06 04:20Z and 04:26Z were 206,352,296
and 207,297,224 bytes (Render logs, read-only; all 92 other checkpoints in 7 days were
under 450 KB; zero failures yet).

## Diagnosis

1. createCheckpoint runs `tar -czf worktree.tar.gz` over HOME minus caches, `.git` and
   files above 25 MB. For a Rose checkout that is the whole tracked working tree:
   `git ls-tree` of origin/main is 12,263 files, 3.77 GB, of which 1.46 GB are files
   at or below the 25 MB per-file cap, 1.16 GB of them under agents/ (the per-branch
   benchmark history ledgers, e.g. span_durations.*.jsonl at up to 25 MB each). They
   compress to ~208 MB.
2. Those files are not session state: restore already rebuilds the repo from HEAD
   (`git fetch` of the remote, the incremental `--not --remotes` bundle, `update-ref`,
   `git reset`), the archive only supplied the files. The bundle was already limited to
   local-only history for exactly this reason ("a full --all bundle of a large repo
   (Rose: 1.4 GB) per checkpoint is not storable"); the working tree was not.
3. Every deploy adds new ledger files to main, so the archive grows with the repo, not
   with the session; the artifact cap (a per-close storage/upload bound) is crossed
   when the repo is crossed. 208.2 MB -> 210.5 MB in ~6 hours of merges.
4. Not the cause of the same run's 5 code spawns. The first code agent's CLI exited
   `exit_code=1` with no handoff.json at 20:41:21.6Z, before the first close/checkpoint
   (close at 20:41:21.78Z, failure 20:41:51Z); the resumes were live resumes of the
   paused sandbox ("Restarting the code-session CLI on resume ... reason=session_ended",
   no checkpoint restore), and a passing run's CLI exited 0. The cause is external: the
   code session output reads `API Error: 402 This request requires more credits, or
   fewer max_tokens. You requested up to 128000 tokens, but can only afford 20478`
   (OpenRouter, the funded gateway route used while the Claude subscription logins are
   rate-limited). With the fix the benchmark still fails the same way (5 spawns, 5
   CLI exits with code 1, timeout) while storing 5 checkpoints of ~13 MB.

First-bad boundary: the archive's contents, not its limit. Rejected: raising the cap
(docs/rca/process-feedback.md B6: never relax a bound to make a failure pass).

## Solution

createCheckpoint archives what git cannot reproduce. For each repo whose HEAD restore
can rebuild (the incremental bundle exists, or HEAD is already on a pushed remote) the
archive omits the tracked files that are unchanged since HEAD (`git diff-index HEAD`
vs `git ls-files`), keeps modified, untracked and ignored files, and the manifest
records `worktreeFromGit`, the tracked files that were deleted (`deletedFiles`) and how
many files were omitted (`gitOmittedFiles`). applyCheckpoint, after `git reset`, runs
`git ls-files -d -z | git checkout-index -q -z --stdin` (only files missing from the
working tree; the archived modified files are left alone) and removes the recorded
deletions. A repo keeps its whole tree when git cannot replay it exactly: skip-worktree
or assume-unchanged entries, submodules, a tracked path with a content filter (LFS), a
path git quotes, or more than 2000 deletions. Manifests without the flag restore as
before. The cap (200 MiB) is unchanged.

Production scale, same real Rose clone (12,255 tracked files, 3.6 GB, one edit, one
deletion, two untracked files): old code worktree.tar.gz 195,201,446 bytes in 20.6 s;
new code 130,151 bytes in 0.83 s (12,255 files omitted, 1 deletion recorded); restoring
that checkpoint rebuilt the tree with an identical `git status` and identical sampled
file hashes (restore 150 s on local disk, dominated by materializing the 3.7 GB tree;
it also restores the >25 MB tracked files the old archive silently skipped). The fixed
code stored 5 close checkpoints of 12.65-13.31 MB (6.0-6.3% of the cap, no failures) in
the end-to-end benchmark run on stack 1794000503-3217075-52777.

Regression: back-end/src/tests/blackbox/code-sessions-checkpoint-size.cases.ts (domain
code-sessions, run by /deploy's backend blackbox suite): a pushed repo with 3 MiB of
incompressible tracked data and a 1 MiB cap fails with the production message before
the fix and passes after, the restored tree has the same `git status`; guards for a
skip-worktree file, a filtered path, a quoted path and a repo that is HOME itself. Five mutations (drop the tar
exclusion, the deletion replay, the checkout, or either guard) each fail exactly their
test. Benchmark: code_agent_checkpoint_stored.

10k agents. Bytes per Rose-repo close fall from ~208 MB to the session's own changes
(KB-MB): at 10k closes/day that is ~2 TB/day of R2 upload and storage avoided, and the
~28 s tar+gzip of the working tree on the sandbox is replaced by git plumbing over
~12k paths. Restore re-materializes the tree from the fetched repo, which a resume
already downloads. No shared state, no new per-agent polling.

## Human feedback

None recorded.

## Reusable lesson

A stored artifact whose size scales with the repository rather than with the session
state will eventually cross its cap: store only what the source of truth cannot
reproduce, never raise the cap.
