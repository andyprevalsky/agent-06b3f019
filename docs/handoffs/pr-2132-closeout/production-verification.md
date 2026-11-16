# PR #2132 production verification (merge 987f2b25a0)

| Lane | Native result | Disposition | Evidence |
|---|---|---|---|
| render | canceled deploy of 987f2b2 | PASS-verified-by-descendant | descendant 1a05bfd85 (contains 987f2b2) live 04:52:54Z, deploy dep-dbsjhttckfvc73dn83l0 |
| backend-probes | PASS | PASS | /health + /api/agents 200, endpoint smoke passed, Render log clean |
| semantic | FAIL (run 43681395952) | verified-by-descendant (not PASS) | `teams-flow.spec.ts:321 expect(settings).toBeVisible()`: 987f2b2 predates #2097's UI change adc4cf9f1a and its spec update 7bc451659c, so the old assertion ran against the new prod UI. Run 43681339469 (source adc4cf9f1a, which contains 987f2b2; head 5bf22d752) passed every job, including Semantic frontend flows. The same failure appeared on 487410ce87 and 5156d47533 runs (43681376432, 43681354141). No repair routed (coordinator ph78393fcn3, 2026-11-15). |
| fly / workflow-migration / agentcard / vercel | n/a | SKIPPED-not-applicable | back-end-only diff |

Original failing gate command from PR #2023's handoff (`BROWSER_PROVIDER_LIVE=1 BLACKBOX_TEST_CONCURRENCY=1 bash scripts/run-blackbox-tests.sh browser-provider`), run on 987f2b2 at 04:58Z: PASS. `live Tilion provider parity` PASS (sessions=4), and the backend logged `AGENTPHONE_API_KEY missing; agent phone creation skipped`, so no prod AgentPhone account use.
