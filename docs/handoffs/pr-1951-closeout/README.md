# PR1951 closeout

[PR1951](https://github.com/Rose-Ai-Labs/rose/pull/1951) merged as `7fa4b30656b23fb53000864cbff0cd5c1fbd9f83`. It closes the repair for the production semantic failure `mobile-layout.spec.ts:194 › header is centered and never wider than the 390 px viewport`. That test failed in run 43085818750 (source 0f8f6da44, PR #1936) with `page.evaluate: Execution context was destroyed`, raised in `injectSemanticSession` at helpers.ts:160.

Root cause: Vercel promoted 0f8f6da44 while the run was in progress. The page had loaded build `80e281dbd690`, and `src/lib/appVersion.ts` reloaded it once onto the newer build. That reload destroyed the helper's pending evaluate. The helper fix, `acrossAppReload`, landed on main in 7b946966b and 1bdd93f9a from the PR #1940 repair owner. PR1951 adds the end-to-end regression `front-end/tests-e2e/app-version-reload-session.spec.ts` and the RCA case `docs/rca/cases/2026-11-11-semantic-helper-evaluate-raced-app-version-reload.md`.

Proof:
- On a local production build whose `/version.json` named a newer build, the unchanged test failed 6/6 on 1666ab29c with the identical stack. A control with a matching build passed 3/3.
- The same test passed 10/10 on 7b946966b. The new regression failed 5/5 before the fix and passed 15/15 after it, plus 6/6 consecutive on the final bytes.
- Gates on 190cc1dbd: quick, structural, frontend/agents coverage, e2b-smoke and semantic-stack PASS. The new spec executed in semantic-stack. Smoke had 11 PASS plus one `agent-payment-abandonment` resource warning (see below).
- Production on 7fa4b3065: Vercel PASS. The production semantic gate passed in run [43099651687](https://github.com/Rose-Ai-Labs/rose/actions/runs/43099651687) with 55 passed, 6 skipped, 0 failed, including `mobile-layout.spec.ts:195` ✓ and `app-version-reload-session.spec.ts` ✓.

Remaining items:
- Sandbox AgentCard release stall: the `agent-payment-abandonment` org transfer `owt_e60fa00a078ffd879450aaea` was consumed with `releasedCents=0`, leaving $43.96 unreleased. It was recorded as `resource_skip` / `agentcard_release_stall`, NOT_INTRODUCED, never PASS.
- The first production-semantic dispatch (run 43096163606) ended in `startup_failure` during GitHub's 2026-11-11 Actions incident (opened 20:48Z; no runs started 20:17–21:00Z). The lane was rerun after recovery.
- Follow-ups recorded in the RCA case:
  - An audit found 16 other prod-mode `page.evaluate` sites within seconds of `goto` with no navigation tolerance.
  - The production-semantic lane waits for Vercel only when `front-end/` changed, yet every main push promotes a new build id.
- CodeRabbit: `no-reviewable-paths`. The path filters exclude both changed files.

Private records are in the encrypted archive described by `private-archive-receipt.json`. Restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>` into a new empty directory.
