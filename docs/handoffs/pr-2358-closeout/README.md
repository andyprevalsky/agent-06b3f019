# PR2358 database timeout repair closeout

Source PR: https://github.com/Rose-Ai-Labs/rose/pull/2358
Source merge: a3944cd513b8a7771b86716156ab7fb26e01d7da
Final validated feature: 3683b914ad93dbbad9e4cf1905131c85594d85c8
Original owner source: 2074c321c5775bc50f4f7ced53d0fb0fae5a348a
Original durable deploy run: 20261116-082244-691995, started 2026-11-16T08:22:44Z.

The runtime repair restores the requested 10s read-only transaction body budget. READ ONLY enforcement, 5s maxWait, three attempts, existing retry classifier and 250ms exponential base remain intact. The original 5s reproduction failed with P2028 five times; the database-backed pg_sleep(6) regression passes with READ ONLY enabled, including native unchanged-code stability evidence. The final feature increment changes only timing commentary and RCA prose; emitted JavaScript is byte-identical to the preceding reviewed source.

## Native validation and original failures

All 17 selected native gates are satisfied on the final feature source: four quick PASS, eleven additional remote PASS, one native unchanged-input stability carry, and qualified smoke PASS. The final smoke contains SIX task PASS and ONE inherited QUARANTINED_FAIL; these are not seven task passes. All owned cohort resources reached native release with no cleanup failure.

Final smoke webdecoy root 758055ca-a8e7-450a-a83e-cc27cb0c6ed8 timed out: `Timeout after 424s (task timeout=420s)`, PAUSED after early-fail, duration445.6s. Existing quarantine remains. Earlier 2074 separately completed all17 gates and7/7 smoke; those receipts remain bound to2074 and are not fresh3683 executions.

Original904 background-message occurrence df8b8c8fdef1423187eec31d764ebd9e failed183s/180s (root4bdfc1f6-0c74-4042-9931-d5010b657d48), then passed its sole same-source automatic rerun: native FLAKY. Recorded RCA is NOT_INTRODUCED: the changed helper never executed, no PrismaP20xx errors appeared, and18LLMspans consumed191s before execute_loop8 was cancelled by the task deadline. The passed rerun is not attribution proof. After confirmed source merge, the full autonomous repair goal and complete encrypted failure cohort were delivered to https://boxes.dev/thread/ph726rz537t23hzq6ec6e0ye018jbmh6 on a different devbox. Native cycle now has0pending postmerge packets. The quarantine remains linked to that repair;37same-day passes that all preceded this incident do not qualify release.

Historical native source-binding and pre-execution PATH-wrapper rejections remain in the encrypted evidence. The wrapper was corrected and verified against the original environment digest before the successful final run. No failed aggregate was rerun solely to conceal a failure; no task prompt, evaluator, timeout, assertion or expected tool was weakened.

Native runner summary (verbatim):

```
Tests skipped (quarantined): 9 — 1 failed (non-blocking), 8 passed
Flaky (passed on rerun): 1 — 1 attributed, 0 awaiting /RCA attribution (blocks merge)
```

The final parenthetical describes the generic unresolved-attribution rule; zero occurrences await attribution.

## Review and merge accounting

CodeRabbit substantively reviewed2074 and delivered two findings. Timing-comment wall-clock guarantee was corrected; the outage-window suggestion was investigated and declined because the explicit requested runtime settings are authoritative. Fast-error retries span about0.75s plus operation time; no hard60s end-to-end completion bound is proven. A read-only independent cross-review checked regression/stability and comment interpretation. Final prose increment3683 was **merged unreviewed** under the native usage-cap exception: organization spending cap, neutral rate-limit check133490626880 and issue6911237698 naming3683. No old Claude fallback was resumed.

The actual merged catalog passes the unchanged strict duplicate-key loader (220tasks). Only background-message quarantine metadata differs from actual first parent9a93980bbba2e250cd8907f6da1da77d9835660a; all main webdecoy incident metadata is preserved unchanged by2358. Existing3b77f392 COST-metadata loss remains owned by PR2411 / ph763756nqm4g29evwgx22m6q18jaj6n. This closeout does not claim that repair complete or copy its patch. The merged database helper is byte-identical to tested3683.

## Execution and protected resources

Successor modelgpt-6.1-sol and high effort are verified from native turn context. service_tier was absent, so successor speed remains UNVERIFIED. Repair launch explicitly requestedgpt-6.1-sol/high/standard, per repair policy. Linux Mac execution was skipped/unverified. No live phone actions/texts, new-device acceptance, setup-policy edits, protected17stoppedMachine destruction or oldGoogle400 restart occurred. Freedom and protected instructions were preserved. The old limited Claude owner remained idle. This is preservation/deletion-readiness evidence, not authorization to delete this devbox or source branches.

Production and final runtime/config preservation are complete, with native receipts in this directory. The original failure cohort, historical exact Git refs, final nonreproducible snapshot and supplemental metadata have verified encrypted carriers. Deletion readiness and records review are recorded separately; carrier verification alone is not deletion authorization. Only safe receipts, identifiers, hashes and recovery instructions are published.

## Completed production verification

Native production aggregate PASS, exact source binding a3944cd513b8a7771b86716156ab7fb26e01d7da. Render deployment dep-dbtkn36417fc73e1qucg served that exact merge. Backend health and agent-list probes returned200; all16 endpoint checks passed and the Render error-log scan found0errors. Semantic workflow43930637872 succeeded on attempt1 with exact source_sha binding: frontend flows and all four lifecycle paths (agent_execute, agent_plan, direct_answer, web_search). Workflow harness headb76525adf8 was a different workflow revision; its explicit tested source_sha remains the merge. No Fly cutover was applicable.

Production URLs: https://navi-j9a9.onrender.com/health and https://www.roselabs.ai . Native workflow: https://github.com/Rose-Ai-Labs/rose/actions/runs/43930637872 .

## Final preservation and recovery

Final capture completed with 68,414 regular files inventoried, 51,047 newly staged data files and 2,156 exact original-smoke files reused from their reverified carrier. The primary archive contains 51,062 members / 2,467,831,584 original bytes; finite metadata archive contains 28 members / 350,068,818 original bytes. Both completed authenticated full readback, separate full verification and independent restore/hash/size/mode checks. All source namespace/content/identity/ownership/mode/mtime/ctime and process guards matched; atime was deliberately excluded because reads can update it. Only two exact reviewed shared Codex cwd-only identities were exempt; no source writer, runtime controller or old Claude was exempt or stopped.

The historical Git carrier was reverified and 19,528 unchanged exact refs remain qualified. Four advanced refs are resolved by retained pushed/merged GitHub ancestry in advanced-ref-dispositions.json; their old exact tips remain in the historical carrier. Native deletion readiness separately checks current local branches/stash/unpushed commits. .git control/refs/logs/index/config and cloudbench custody records are in the encrypted snapshot; .git object storage relies on the exact historical bundle plus durable pushed advances. Reflog-only/unreachable objects are not claimed preserved.

Private manifests retain exact source paths and recovery mapping. Original configs/logs/native Claude project transcripts were captured; dependencies/builds/reference checkouts use the native reproducibility rules. Archive staging/restore copies are reproducible from the verified carriers. The final guard files are byte-identical to earlier archived guard records (hashes in preservation-coverage.json). Later safe records, native readiness, review metadata and scorecards are preserved by this records PR or native external GitHub/visual receipts, not falsely claimed inside their own archive. No later runtime/config writes occurred.

RECOVERY.txt documents the unchanged helper and existing authoritative key/config. Restore to a new empty private directory, verify hashes/size/mode and use the encrypted source mapping deliberately. Never overlay an active checkout, configuration or Freedom. The separate repair owner already authenticated and restored the original 2,156-file cohort on its independent devbox.

A transient parent folder-read readiness race was reported through the boxes-feedback skill (event4c978259318444ea8bfeec0d8cca8fc0); later native parent get and child get both verified Bugs placement. It did not block or invalidate the handoff.
