PR #2378 closeout (records for the PR #2221 entry-load-recovery.spec.ts:156 repair; fix shipped in PR #2331, merge
6f956dd35c). Repair devbox 73e26395 (Bugs). Details: docs/handoffs/pr-2221-entry-load-156-repair/README.txt.

Merge: bb2c7ce08739 (PR #2378). Gates: 5/5 PASS (eslint, typescript, backend-structural, e2b-smoke, format); review:
no reviewable paths. Production: semantic PASS-verified-by-descendant, run 43837731287 (live 12b77e3e7a, 69 passed,
entry-load-recovery.spec.ts:329 = the former :156 passed).

Original command (production-semantic --merged-sha 55655e6544, from this devbox): run 43830591712. The assigned test
passed in both attempts. The other failures are NOT_INTRODUCED and were handed off after merge:
  - teams-flow.spec.ts:21 390px: AppVersion reloaded onto an OLDER build reported by a lagging edge. New repair goal:
    https://boxes.dev/thread/ph7809yq1mdwp4qmebv5tajt018jae28 (devbox 0e415837, Bugs, Opus 5.5 high, standard).
  - attempt 2 (projects-sidebar-flow.spec.ts:46 x2, teams-flow.spec.ts:21 1280px): the retry reran stale 6f956dd35c
    specs after PR #2275 changed the live UI. Delivered to the matched owner, PR #2339:
    https://boxes.dev/thread/ph70h18srpwfhssk1rggdzxxbs8jbz74 (accepted; its fix makes rerun and
    --retry-failed-once refuse that skew).

Private archive: private-archive-receipt.json (.context and local logs on devbox 73e26395). Template-inherited
branch/env entries in closeout-manifest.json are copied from docs/handoffs/pr-2221-closeout (tips verified).
