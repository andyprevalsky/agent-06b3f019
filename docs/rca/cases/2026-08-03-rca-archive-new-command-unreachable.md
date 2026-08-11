---
id: 2026-08-03-rca-archive-new-command-unreachable
date: 2026-08-03
title: RCA archive registered the new subcommand but never dispatched it
surface: harness
component: rca-archive-cli
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/rca_archive.py:main parsed the new command, then fell through to return 2 because no dispatch branch called new_case"
symptoms:
  - "python3 scripts/rca_archive.py new <slug> exits 2 with no output"
  - RCA instructions require a scaffold command that cannot create a case
tags:
  - rca-archive
  - cli-dispatch
  - unreachable-command
sources:
  - commit 99ab926cdf
repro: back-end/src/tests/structural/rca-archive.test.ts
status: fixed
---

## Problem

The documented `python3 scripts/rca_archive.py new <slug>` command exited with
status 2, printed nothing, and created no file. Both `/RCA` and the archive README
instruct every investigation to use that command, so case creation required an
undocumented manual workaround.

## Diagnosis

The CLI parser registered the `new` subparser and accepted its required `slug`,
and `new_case()` was fully implemented. The `main()` dispatch chain handled
search, show, list, stats, reindex, and validate, but had no `args.command ==
"new"` branch. Valid input therefore fell through to the terminal `return 2`.
The deeper cause was a logical inconsistency between the advertised CLI contract
and its dispatch table, made possible because the structural gate validated
search and schema behavior but never executed the scaffold command.

## Solution

`main()` now dispatches `new` to `new_case(args.slug)`. The RCA archive structural
gate copies the CLI into an isolated temporary repository, invokes `new` with a
fixed date, and asserts the expected scaffold exists; it cleans the temporary
tree afterward and never mutates the real archive. The gate failed with exit 2
before the fix and passes after it. This is constant work per deploy and does not
scale with agent count.

## Human feedback

None recorded.

## Reusable lesson

Exercise every documented CLI subcommand through its real dispatch path, not only the helper functions behind it.
