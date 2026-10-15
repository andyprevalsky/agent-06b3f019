---
id: 2026-10-15-coverage-unit-combined-independent-db-replay
date: 2026-10-15
title: Coverage unit combined independent database replay beyond the file size contract
surface: harness
component: backend-coverage-unit-tests
classification: our-bug
problem_class: other
first_bad_boundary: The merged coverage-script.test.ts combined coverage launcher contracts and a standalone prepared-database replay into 642 ESLint-counted lines
symptoms:
  - File has too many lines (642). Maximum allowed is 600
  - 629:1 error max-lines
tags:
  - coverage
  - eslint
  - module-boundaries
  - database-isolation
sources:
  - commit 10716a5b101d7a8c05ef0dfb3b2bccdd63bec5b7
  - task .context/lantern-deploy-preflight/.context/preflight-artifacts/eslint-10716.log
  - task .context/lantern-coverage-split1071/.context/coverage-split/final-proof.json
repro: cd back-end && node /home/boxes/rose/node_modules/eslint/bin/eslint.js src/tests/unit/coverage-script.test.ts
status: fixed
---

## Problem

The expanded deployment ESLint gate rejected the merged 10716a5 source because
`coverage-script.test.ts` contained 642 counted lines against the existing
600-line limit. The same affected-file ESLint invocation reproduced that exact
error in an isolated detached worktree before any correction. This was a test
module boundary failure; no production database, credential, provider or native
benchmark failure is implied.

## Diagnosis

The coverage launcher contracts and an independent prepared-database URL-selection
replay accumulated in one unit file. The database replay already owned its own
temporary directory, fake `psql`, assertions and cleanup. It did not need shared
state from the other cases beyond reading the actual coverage shell script.
Removing that complete responsibility from the oversized file, while preserving
its bytes, makes the unchanged lint contract pass.

Archive search for test-file size, max-lines and module splitting found the
October 6 Hub storage module-size case. The same boundary lesson applies, but
this incident concerns a newly combined unit-test owner rather than production
storage responsibilities. There is no evidence that the 600-line rule or the
prepared-database assertions were wrong.

## Solution

Move the existing prepared-database replay at EOF to the automatically discovered
`back-end/src/tests/unit/coverage-script-db.test.ts`. Add only its required imports
and the same coverage script read. Keep the rest of the original unit unchanged,
including main's supervisor-fixture inheritance checks. Do not use the existing
part2 file, alter ESLint limits or overrides, rewrite the shell branch, or change
any assertion.

The moved block is byte-identical: 3,515 bytes, SHA-256
`8d0a8cf73ff50f65584cc82ba0134147e5bd9b2d7ce6dd51092c9b388d751cd3`.
The retained original prefix is also byte-identical apart from its final blank
line. The replay still executes the actual production URL-selection branch,
uses an owned fake `psql`, and preserves every accepted/rejected URL, canonical
workspace, marker, path and primary-workspace control.

The same affected-file ESLint command changes from the recorded max-lines error
to exit 0; ESLint on both resulting files also passes. Running both actual files
with `node --import tsx` passes: the original coverage contracts include six
embedded checks, and the standalone database replay reports PASS. Executing the
normal unit runner's exact discovery function, without launching its suite,
finds both files. Targeted strict TypeScript checks, Prettier and diff checks
pass. Commands, logs, file hashes and discovery proof remain under the source
artifact directory listed above. These are local owning-boundary receipts,
not a replacement for the complete deployment gates on the eventual commit.

## Human feedback

None recorded.

## Reusable lesson

Keep an independent fixture replay in its own automatically discovered test file while preserving its assertions and the existing file size contract.
