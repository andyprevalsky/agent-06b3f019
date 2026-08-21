---
id: 2026-08-03-rca-archive-new-command-missing-dispatch
date: 2026-08-03
title: The RCA archive CLI registered the new command but never dispatched it
surface: harness
component: rca-archive-cli
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/rca_archive.py main — argparse accepts new but the command dispatch falls through to return 2
symptoms:
  - "python3 scripts/rca_archive.py new <slug>" exits 2 with no output
  - no RCA case file is scaffolded by the mandatory archive-write command
tags:
  - rca-archive
  - cli-dispatch
  - workflow-gate
sources:
  - commit 5ef01b873df0d5584eda74461337a1f251356d4f
repro: back-end/src/tests/structural/rca-archive.test.ts
status: fixed
---

## Problem

During the mandatory archive-write step, two invocations of
`python3 scripts/rca_archive.py new
live-view-completion-conflates-handoff-mode-with-steel-provider` produced no
file. A follow-up invocation that printed the process status recorded exit 2,
even though `--help` listed `new` and accepted its required slug.

## Diagnosis

`main()` registers the `new` argparse subparser, and `new_case()` contains the
working scaffold implementation, but the command-dispatch chain handled every
other registered subcommand and then returned 2. There was no
`args.command == "new"` branch. The mismatch was possible because structural
coverage asserted that RCA instructions mention the command but never executed
the command itself.

## Solution

`main()` now dispatches `new` to `new_case(args.slug)`. The RCA archive
structural test copies the CLI into an isolated temporary repository, executes
`new` with a fixed date, and asserts that the expected case file exists. The
same production command then scaffolded both cases for this investigation.
This is one local process and one file write per RCA, with no runtime or
agent-count-dependent work at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Exercise every documented workflow subcommand end to end instead of testing only its help text and instruction references.
