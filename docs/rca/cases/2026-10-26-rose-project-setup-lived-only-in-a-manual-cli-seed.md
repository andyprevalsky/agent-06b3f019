---
id: 2026-10-26-rose-project-setup-lived-only-in-a-manual-cli-seed
date: 2026-10-26
title: Rose project setup existed only as a manual rose-sync CLI seed, so Andy's prod Rose project stayed name-only
surface: back-end
component: projects
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: back-end/src/domains/projects/service.ts listProjects returned a dev account's name-only Rose project as-is; the PJ4 setup lived only in scripts/lib/rose-sync/cli.mjs seedRose
symptoms:
  - 'Project settings Repository "No repository", GitHub "Not connected", Last synced "Never", Environment files 0, empty startup script'
  - i told u setup rose out of box for me
  - Rose project not configured out of the box
tags:
  - projects
  - rose-builds-rose
  - pj4
  - seed
sources:
  - commit 1bc7a0a32
  - commit 1e593833d
  - plan: docs/plans/active/rose-builds-rose.md PJ4
repro: back-end/src/tests/blackbox/projects.blackbox.ts ("Rose out of the box" cases)
status: fixed
---

## Problem

Andy's Rose project in production showed no repository, GitHub not connected,
no startup script and zero environment files. A read-only production query on
2026-10-26 found that this was the only Project row in production
(`1ec468d5-…`, name `Rose`, created 15:52:36Z). Its `repoUrl` and
`startupScript` were null, `syncRevision` was 0 and it had no env files. Andy
had no GithubRepoAccess grant for `Rose-Ai-Labs/rose`; no account had one.

## Diagnosis

PJ4 of `docs/plans/active/rose-builds-rose.md` specifies the Rose project
configuration. That setup was implemented only as `scripts/rose-sync
seed-rose`, which someone had to run from Andy's checkout with a personal
credential. Its status read "Live smoke open: run from Andy's checkout after
deploy". No product path applied the same defaults. Creating "Rose" through
the UI's "+ New project" stores only a name. `listProjects` returned that row
unchanged, and nothing granted clone access to the private repository.

Why was it possible: the requested default lived in an operator procedure
rather than the product. The next "why" would question manual seeding as a
design choice, and Andy explicitly rejected that choice ("set up out of the
box"), so the analysis stops at that boundary.

Repro: the new `projects` blackbox cases create a name-only Rose project for
the Rose dev account, then list it. On base the result was `not ok 7 … error:
'repo null'` and `not ok 8 … 'one Rose row, got 0'`. Reverting only the
`service.ts` hunk reproduced the same failures.

## Solution

`back-end/src/domains/projects/roseProject.ts` contains a pure planner and an
idempotent applier, and `listProjects` invokes them. For Rose dev accounts
(`isRoseDevUser`), they create a missing Rose project, or fill in a pristine
one. The filled-in setup is repository `https://github.com/Rose-Ai-Labs/rose`,
branch `main`, the PJ4 startup script, six declared env files (paths only)
and a GithubRepoAccess grant. A renamed Rose-repo project still counts as the
Rose project.

Conditional and skip-duplicate writes make later edits and concurrent lists
safe. Setup failures are logged and never fail the list. Env-file values still
arrive only through codebase sync.

`back-end/scripts/setup-rose-project.ts` provides a READ ONLY dry run and
`--apply`. At 10k agents, non-dev accounts return before any query. A dev
account performs one bounded write burst, then no extra queries on later lists.

## Human feedback

Andy, 2026-10-26: "i told u setup rose out of box for me". In the same review,
he described the project settings "Development environment / Download setup
helper" block as "wtf is this part?", and that block was removed.

## Reusable lesson

When a plan row says an account should be "seeded", put the seed in the product
path that every fresh account reads. A CLI step that someone has to remember
does not satisfy that requirement.
