PR #2221 semantic repair: entry-load-recovery.spec.ts:156 "an entry 404 cached as immutable is refetched
before the reload and the app mounts" (Expected 2, Received 3 at :168:25). Repair devbox 73e26395 (Bugs folder),
thread "--ai-- Repair entry-load :156 alias-switch count (PR2221)". Records only: the code fix landed in
PR #2331 (merge 6f956dd35c, owner thread ph7asdf6a54w6mm0tpzkd0e79d8j8jpg, which already held this test from
PR #2184). This devbox made no duplicate edit.

Failure: production semantic run 43691173465 (job 132741958284), source 55655e6544 (PR #2221, docs-only).
Root cause (trace-timeline.txt): all three documents were the SAME build (entry index-BkA2eS2J.js, HTML age=1,
promoted 07:44:15Z). The test injected one immutable 404. The recovery's revalidate then reached a real Vercel
edge node (sfo1::v84cb) that served the freshly promoted HTML before it held the assets, and got a second, real
immutable 404. Document 2 replayed it from cache, recovered once more, and document 3 mounted. The product was
correct (each reload followed a real 404). The test counted a fault it never injected. The 8207c0b361 promotion
reloaded document 4 only after the assertion.

Repro: repro/edge-sim.mjs (a proxy in front of production that returns the entry's first upstream request as the
immutable 404). FRONTEND_URL=http://127.0.0.1:4517 npx playwright test tests-e2e/entry-load-recovery.spec.ts
-g "cached as immutable":
  origin/main 888b6e40bd (before the fix)   FAIL  Expected 2, Received 3 at :168:25 (same as production)
  PR #2331 head bba5cfe92a                  PASS  (edge 404 served and absorbed)
  main 6f956dd35c, repro/run-edge-5x.sh     PASS  5/5, one real edge 404 per run (test now at :329)
  main 6f956dd35c vs https://www.roselabs.ai PASS  :329 5/5 (--repeat-each=5); whole spec 10/10
The fix (PR #2331, pinLiveBuild): the test origin snapshots the build under test (HTML and its assets) and serves
it, so a real edge or origin 404 of its entry cannot add a reload. Assertions (loads.count 2, entryRequests >= 2)
and timeouts are unchanged. RCA case: docs/rca/cases/2026-11-15-semantic-fe-app-version-reload-on-promote-
miscounted-and-aborted-goto.md (cites run 43691173465 and this edge-sim repro).

Original command rerun from this devbox (run_deploy_pipeline.py production then production-semantic,
--merged-sha 55655e6544, binding verified-by-descendant, source 6f956dd35c): run 43830591712.
  attempt 1: entry-load-recovery.spec.ts:329 PASS (all 11 entry-load tests pass). 1 other failure:
    teams-flow.spec.ts:21 390px "page.evaluate: Execution context was destroyed" at :267. NOT_INTRODUCED. Trace:
    the document loaded build 99ca195f9c (HTML age 3). /version.json from a lagging edge (age 137) reported the
    OLDER build ceaad55dc8, and AppVersion reloaded onto it ("replaced by ceaad55dc862-mwizvuf0 (load)"). That
    build's entry then 404'd and EntryLoad reloaded again. Handed off as a repair goal after this PR merged.
  attempt 2 (--retry-failed-once): :329 PASS. 3 other failures (projects-sidebar-flow.spec.ts:46 x2,
    teams-flow.spec.ts:21 1280px) timed out on "Rose folder settings". NOT_INTRODUCED: the retry reran source
    6f956dd35c's specs after PR #2275 (merged 08:20Z) had removed that button from the live UI (current main
    deletes projects-sidebar-flow.spec.ts and changes teams-flow). This is spec/UI skew on a retry.
  This deploy's own production semantic lane is recorded in the deploy scorecard.

Private archive: private-archive-receipt.json (.context: el156-evidence = both job logs, both Playwright
artifacts and extracted traces, the shelved alternative patch, poll logs, production-semantic state/log).
