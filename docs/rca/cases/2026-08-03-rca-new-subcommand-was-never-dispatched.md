---
id: 2026-08-03-rca-new-subcommand-was-never-dispatched
date: 2026-08-03
title: RCA archive advertised a new command that main never dispatched
surface: harness
component: rca-archive-cli
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/rca_archive.py main parsed the new subcommand but fell through to exit 2
symptoms:
  - python3 scripts/rca_archive.py new exits 2 with no case file
  - rca_archive.py new produces no output
tags:
  - rca-archive
  - cli-dispatch
  - command-contract
sources:
  - commit 067e37787b8c66ea97e407d27f4bc577c8ab341e
repro: back-end/src/tests/structural/rca-archive.test.ts
status: fixed
---

## Problem

While recording a deploy-gate RCA, the documented command
`python3 scripts/rca_archive.py new backend-test-tsx-resolution` exited 2,
printed nothing, and created no file. `--help` still listed `new`, so the CLI
contract and runtime behavior disagreed.

## Diagnosis

`main()` registered the `new` argparse subparser and `new_case()` was fully
implemented, but the command-dispatch chain handled search, show, list, stats,
reindex, and validate before unconditionally returning 2. Code inspection tied
the observed exit code directly to that fall-through. The deepest owned cause
was a command contract split across parser registration and a separate manual
dispatcher without behavioral coverage for every advertised command.

## Solution

`main()` now dispatches `new` to `new_case(args.slug)`. The RCA archive
structural test executes the command against a temporary cases directory and
requires the scaffold path in its output, so parser/dispatcher drift is caught
without mutating the real archive. The repaired command then created this case
successfully. This is deploy tooling only and has no runtime work, queries,
channels, locks, or per-agent cost at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Behaviorally test every advertised CLI subcommand so parser registration cannot drift from command dispatch.
