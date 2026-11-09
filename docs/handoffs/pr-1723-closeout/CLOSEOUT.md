# PR 1723 deletion-readiness closeout

Status: post-merge record. The committed `deletion-readiness.json` beside this file is the record of record.

- Deployed PR: [#1723](https://github.com/Rose-Ai-Labs/rose/pull/1723) "GitHub token pool + org GitHub App (rose-labs-agents) as a pool member", branch `feat/github-token-pool`, merged 2026-11-08T02:54Z as `d78719f5b46182b87bb7dcc0197e26c619323764` (validated head `a48ed602ffa33b395a78f134350d779ba70446b6`).
- No credential, key or secret value is in this record. Env files appear by name only.

## 1. Gate history

| Head | Result |
|---|---|
| `0d7de94dc` (v1 staged cycle) | 3 gates failed on main's own tests (fixed on main concurrently; this branch kept main's fixes) |
| `aa01493d1` | READY on v1; smoke guests refused a stale warm image after main's Node update; resolved by merging main |
| `2449803fd`, `6c91048a7` | GitHub token resolver fallback added after the user token sat at 0/5000 (RCA `2026-11-07-cloudbench-token-resolver-had-no-candidate-outside-the-drained-user-identity`) |
| `7b243b4ec` (deploy v2, Blacksmith) | 16/16 PASS after repairs (stale Prisma client, shared ngrok domain, warm-deps refresh, measured Machine ceiling) |
| `233012993` | 16/16 PASS |
| `55524eb88` | merge with main's `githubRateLimit.ts`: main's wrapper keeps the rate-limit rules and the pool is its `fetchImpl`; 16/16 PASS twice. Merge refused (exit 5) because the cycle bound an exported, rotated `GH_TOKEN` and then a session restart changed the environment |
| `a48ed602f` | **16/16 PASS** in a fixed `env -i` environment, `PIPELINE_VERIFY exit=0`, merged |

`smoke/agent-payment-abandonment` hit the standing AgentCard sandbox release stall on several runs (transfers consumed with `releasedCents=0`); each was recorded as a warning skip, never a pass.

Review: cycle 1 (`e52d8127d`) had 5 CodeRabbit findings, all fixed. Every later head hit "Review limit reached — usage spending cap"; those cycles closed as `skipped` (`usage-cap`). The later commits were **merged unreviewed**.

Production lanes at the merge commit (`evidence/production-lanes.json`): render PASS (live 03:01Z), backend-probes PASS, semantic PASS (chat-lifecycle-ratchet run 42440932318); fly, vercel, mac-release, wmh, workflow-migration and agentcard SKIPPED-not-applicable.

## 2. What is preserved, and where

Encrypted archives (`ROSE-PRIVATE-TAR-GCM-V1`) in the private R2 trace bucket under `devbox-closeout-private/pr1723-a48ed602/`. Every upload was read back in full with per-frame authentication and member hashes; `control` was also fully restored (2526/2526). Receipts (key, hashes, sizes) are in `closeout-manifest.json`.

| Archive | Contents |
|---|---|
| control | this deploy's working directory (notes, triage inputs, scripts), review and approval ledgers, deploy-run artifacts |
| cycle-state | `.context/deploy-pipeline` entries after the PR 1691 closeout cutoff (every cycle, kept unchanged) |
| cloud-a, cloud-b | `.context/deploy-cloud` smoke campaigns after that cutoff |
| workspace-rest | other `.context` records and `.llm-dumps` changed after the PR 1751 cutoff |
| git-refs | read-only git bundles of `backup/cerebras-chat-quota-prepush-20261002` (12d996f0) and the stash `0e2ffe95`; both left in place for their owner |

Not archived: reproducible caches (`node_modules`, `agents/venv`, `__pycache__`, `tsbuildinfo`, `fast-forward-cache`, locks); 267 credential-bearing files excluded by the secret scan (counts per archive in `closeout-manifest.json`); the GitHub App credential directory. The App settings are on Render.

Benchmark history: `scripts/benchmark-history-backfill.py --dry-run` found 0 rows to add; this deploy's cloud smoke rows reach the Hub without a code identity (same gap as the PR 1767 closeout).

## 3. Deletion readiness

`deletion-readiness.json` reports NOT_READY. The only remaining open item that isn't transient is the boxes.dev Codex app-server (`codex app-server`, parent systemd, cwd in this checkout). It is the devbox's Codex runtime, not a project record, so it is left for the devbox owner. Fourteen idle Hub processes from this devbox's finished deploy campaigns, one idle `fleet/runs` Hub and the flyctl agent were stopped (`evidence/cycle-restart-notes.txt`).

Follow-ups: managed-env delivery of `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_B64` needs the `edit-project-settings` permission. The deploy cycle should exclude per-session and credential variables from its environment digest. The shared `rose-rose.ngrok.app` domain collides across concurrent Blacksmith semantic gates.
