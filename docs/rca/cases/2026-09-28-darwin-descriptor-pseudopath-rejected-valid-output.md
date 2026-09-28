---
id: 2026-09-28-darwin-descriptor-pseudopath-rejected-valid-output
date: 2026-09-28
title: macOS descriptor pseudopath rejected valid Claude Code output files
surface: back-end
component: claude-code-local-file-read
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/claudeCodeLocalFileRead.ts resolveOpenDescriptorPath
symptoms:
  - "Local output candidate escaped its session directory through a symlink"
  - "FAIL claude-code-local-session.test.ts (425084ms)"
  - "claude-code-local-close.blackbox.ts did not exit after valid file extraction failed"
tags:
  - darwin
  - claude-code
  - local-session
  - descriptor-path
sources:
  - commit a58f662a6244609b14b09435254f8d653b09ed2d
repro: back-end/src/tests/blackbox/claude-code-local-close.blackbox.ts
status: fixed
---

## Problem

During backend coverage on macOS, local Claude Code close rejected ordinary
output files with `Local output candidate escaped its session directory through
a symlink`. The unit and blackbox children kept their local listener processes
open after the failed extraction, so coverage made no progress for over seven
minutes. A focused blackbox run showed the valid-file cases failing before
the fix, while symlink rejection remained a separate expected behavior.

## Diagnosis

Archive searches for the exact symlink error and for macOS `/dev/fd`
resolution found related local close work but no case for this path boundary.
The path was a valid file under `/tmp/claude-code-local/<task>` → opened with
`O_NOFOLLOW` → `realpathSync.native('/dev/fd/N')` on Darwin returned the
pseudopath `/dev/fd/result.txt` → containment compared it with the canonical
root `/private/tmp/claude-code-local/<task>` and rejected it. A local opened
descriptor showed `lsof -Fn` resolving the same file correctly to
`/private/tmp/claude-code-local/<task>/result.txt`. The first bad boundary
was accepting a Darwin descriptor pseudopath as the real opened file path.

## Solution

Darwin now resolves the opened descriptor through the existing bounded `lsof`
path, while Linux retains `/proc/self/fd/N`. The descriptor, inode, size, and
root containment checks remain in place. The unchanged local-session unit
test passed 13 of 13 cases and the unchanged close blackbox passed 7 of 7
after the fix; both had failed or hung on the old code. For 10,000 agents,
the work is per output file and retains no new shared state; the Darwin
subprocess keeps its existing two-second timeout.

## Human feedback

None recorded.

## Reusable lesson

Resolve an opened file descriptor through a platform-verified canonical path before applying root containment checks.
