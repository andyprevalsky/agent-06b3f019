# PR1918 closeout

[PR1918](https://github.com/Rose-Ai-Labs/rose/pull/1918) fixed the chat failure for agent `ebb350db-303b-4e6a-b8b0-2d40dc9f9251` and merged as `3d3b9a2de7c600d0b9665f8b312bc99cbae02de1`. A large recent tool result survived compaction: estimated context grew from 786,002 to 787,018 tokens, and both router attempts expired. The repair summarizes oversized tool bodies under pressure while preserving message identity, order, metadata and the persisted original.

A controlled reconstruction using the real compactor and unchanged real router reduced the estimate from 785,994 to 1,717 tokens. Compaction took 1.222 seconds and the router returned a validated grep decision in 0.520 seconds; the full diagnostic took 2.453 seconds. The raw control reproduced a 30.018-second expiry and a context-limit error. These are reconstructed calls, not original production wire captures. The original user's research task is not claimed completed.

The final source contained 19 intended paths: four for the chat repair, tests and RCA; three for the reused retry reporter; nine for necessary recovery and evidence controls; and three for published AgentCard pagination. Final backend validation reported 258 passing cases. Frontend validation reported 4,733 passing tests across 324 files and one skipped test. Agent coverage, 112 structural suites and the live probes passed. All 19 permanent compaction cases passed repeatedly. Native failures, interrupted runs and financial obligations remain preserved.

Production Render served the exact merge; endpoint/schema smoke and the log scan passed. All four production chat lifecycle paths passed. Production UI retained 48 PASS, 4 FAIL and 6 planned SKIPPED. Actual traces established that the four failures were additional failures not introduced by this repair; complete repair goals were delivered after merge. The AgentCard production preflight refused persisted sandbox billing before allocation. Its external billing-configuration exception is not a lifecycle PASS. The native production command's exit 1 remains unchanged.

Independent autonomous Bugs goals own the additional failures:

- [Sidebar disclosure and mobile activity](https://boxes.dev/thread/thr_bf0d1c6f6d034893b94c884ac213eab0), including the three production sidebar failures.
- [Declared benchmark judge identity](https://boxes.dev/thread/thr_afc688112f6d4f64838ffd240264e9d5), distinct from the older credential-GET stall named by the existing quarantine.
- [Production entry-load fixture skew](https://boxes.dev/thread/thr_9d1c16208c1448f496369f8e5585d385): the fixture selected an older entry filename and missed the script used by navigation, so it injected zero intended 404s.

Tests skipped (quarantined): 1 — 1 failed (non-blocking), 0 passed. The native mass task remains ERROR; adapter projection and delegation are not task success. CodeRabbit reached its confirmed organization spending cap on the stabilized source; PR1918 merged unreviewed after stabilization. Direct Anthropic API credential health retained its exhausted-credit warning. Mac-only acceptance remains unverified on Linux.

Financial warning: the sandbox abandonment run last retained 4,396 cents transferred and zero released, a closed card with zero balance, a HELD purchase and RECLAIMING funding. The $43.96 sandbox duty remains unreleased, without settlement credit. Production user107 needs a dedicated live billing/cardholder configuration. No billing, credential, cardholder, KYC or financial workaround was performed.

The private archives preserve needed local evidence, all 19,532 frozen references, 602 historical branches, 72 local-only branch tips and the stash without integrating or deleting them. Exact restore results are in verification.json. Native operational sidecars are retained separately from the Git bundle. A bounded supplement preserves records after the primary cutoff. Later public follow-up commits and PR metadata are durable in Git/GitHub. Raw environments, traces, logs, provider payloads and encryption keys are never committed here.

This follow-up changes documentation records only. The original deployment run is `20261110-231347-3020855`, started November 10 at 3:13:47 PM PST; native finish completed at 9:23:03 PM PST. Archive and records closeout retain that original lifetime.
