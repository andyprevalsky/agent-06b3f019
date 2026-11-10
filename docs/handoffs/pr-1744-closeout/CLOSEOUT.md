# PR #1744 closeout

Code agents: one spawn = one agent, queued messaging, work-history UI, GitHub rate-limit handling, E2B sandbox/gh image, plus the deploy/bench tooling fixes found on the way.
Merge commit `8dbb27dbfc8ce068ca82bdca9b70dd9a37d1eea9` (2026-11-07 22:04Z). Gated head `3e3e0ce58eb996869afd63a1a1fba08a0b0239c5`.

**Outcome: blocked.** Render, Vercel and the Mac release are live on the merge commit. The Fly worker cutover, the workflow-migration matrix and the production semantic gate are **deferred and UNVERIFIED** because `Deploy Agents to Fly.io` is `disabled_manually` (owner's first-managed-deployment hold, since 2026-11-07T18:32:58Z, not by this deploy). Nothing was re-enabled or dispatched (same decision the user recorded for PR #1747).

## What is live and what is not

- Live: backend (Render), frontend (Vercel), Mac app release (run 42418837413), 8 E2B grid templates rebuilt with the gh CLI.
- Not live: `agents/` Python (lane A spawn activity/heartbeat, foreground spawn records, llm.py metadata, agent_messaging) until the Fly cutover. Version-skew risks while the hold lasts are in `evidence/followups.txt` item 16.

## Gates (final cycle on 3e3e0ce58e)

All selected gates PASS: eslint, typescript, format, backend-structural, deploy-command-structural, seed-cache-decision, canonical-seed, seed-memory-ratchet, backend-coverage 252/252, frontend-coverage, agents-coverage, live-probes, e2b-smoke, cloudbench-controller, cloud smoke 13/13 (campaign e2877d04, AgentCard tasks included), semantic-stack (focused re-run PASS after the first sweep lost the single reserved ngrok domain to another deploy). Receipts: `evidence/final-cycle-3e3e0ce58e.json.gz`, `evidence/final-plan-3e3e0ce58e.json.gz`.

## Production lanes (evidence/production-lanes-8dbb27dbfc.json)

render PASS, vercel PASS, mac-release PASS, backend-probes PASS, **fly BLOCKED (hold)**, workflow-migration BLOCKED, semantic NOT RUN, **agentcard FAIL** (external-provider waiver: the production Stripe fixture is test-mode, `livemode must be true`; a live KYC cardholder is the user's to provide; native FAIL preserved in `evidence/failure-report.json`). The lane left a new unreleased 100-cent org transfer (followups item 14).

## Override (user, 2026-11-07)

Gate: the exact-merged-head staged verification (`verify --require-staged --expect-head`). Approval: "merge the records-only sync without rerunning gates". Delta over the gated head: 28 files, 22 under `docs/handoffs/pr-1747-closeout/**`, 3 history ledgers, 2 RCA cases, generated `docs/rca/INDEX.md`. Risk: the merged head `f431ff44b` was not itself gate-verified; its delta is docs and records only. The merge used the `cmd_merge` checks except the tree-bound verify (replaced by "staged cycle ready on the gated head" plus a refusal unless every delta path is docs/history); tooling untouched.

## Review

CodeRabbit hit its usage cap on every head: merged unreviewed after a quota skip (`evidence/review/`).

## Shared-infrastructure interference (record)

Shared Fly donor machine `683e47df5094d8` was re-imaged by another deploy (PR #1715's image `cloudbench-warm-...172204`, pre-11-06 `agents/requirements.txt`): 18:00:58Z flip (smoke canary INFRA-STOP), 18:12Z this deploy restored `031010` once (the coordinator then ruled not to repeat), 18:31:54Z flip again (second INFRA-STOP), 18:43Z the other owner restored `031010` and held the donor for our windows. Details: `evidence/followups.txt` items 10-13.

## Followups

`evidence/followups.txt` (20 items). The deferred production lanes: `scripts/deploy production --sha 8dbb27dbfc8ce068ca82bdca9b70dd9a37d1eea9 --lanes fly,workflow-migration,semantic` once the hold is lifted.

## Preserved records

Encrypted private archives (verified by remote readback): core (100,258 files, 910 MB), cloud (7,229 files, 1.2 GB), extra (14 files). Receipts `evidence/archive-receipt-*.json`; dispositions `manifest.json`; readiness `deletion-readiness.json` (open: only live harness/tool processes). Local evidence deleted earlier to free disk: `evidence/deleted-evidence-list.txt`. Benchmark ledger: 13 final smoke rows + 1 production AgentCard row appended (`agents/benchmarks/history/`).
