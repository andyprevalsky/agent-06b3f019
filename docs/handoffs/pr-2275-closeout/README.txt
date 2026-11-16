PR #2275 closeout: projects are repos (GitHub Repositories in Integrations, folders-only left bar,
import from your computer via the Mac app, per-user GitHub credential, # Available projects).
Merged f04d18333323 (2026-11-16).

Gates: 17/17 PASS on de6ba6bf33 (6 rounds). Introduced and fixed in-deploy: new-schema canonical seed
(pg15/pg16 published via scripts/migrate-canonical-seed.sh), two FE fixed sleeps, teams-flow e2e used the
removed folder gear. Main-red while deploying (not introduced): provider_capacity_refusal stubs (fixed here),
delegating-ceiling fixture (#2324), cleanup-admission sleeps (291a20af54/d7bf486872), each synced in.
Approval: APR-PROJ-2 GROUNDED (golden-reference reviewer) @ 3b173c1288; APR-PROJ-1 NOT_GROUNDED -> fixed.
Review: CodeRabbit organization usage cap on every reviewable head -> usage-cap skips (merged unreviewed).
Production: DEPLOY_PRODUCTION PASS; render + semantic PASS-verified-by-descendant; fly, vercel, mac-release,
backend-probes, workflow-migration PASS (mac-release and semantic reran after a GitHub REST quota reset).
Private archive: private-archive-receipt.json (.context + .llm-dumps, 84247 files, full readback verified).
Unverified (macOS only): mac-app-coverage-blackbox, mac-app-static, electron-builder packaging, real-Mac run.
