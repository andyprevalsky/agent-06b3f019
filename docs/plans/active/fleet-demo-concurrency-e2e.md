# Fleet infra + DEMO concurrency guarantees

## Coordination

Works **alongside** Conductor PR
[#1285](https://github.com/Rose-Ai-Labs/rose/pull/1285) (`andyprevalsky/riga`),
which owns `/descend` rolling-lane orchestration, campaign_cap, and Fleet
teardown/identity hardening. This plan adds the **substrate canary** and the
**deploy-facing concurrency e2e**; it does not rewrite #1285's campaign
supervisor.

## Problem

`/descend` repeatedly burns wall-clock on **Infrastructure Failure** (barrier
exclusions, boxes that never start, post-release stop without DONE, rate limits,
teardown leaks). Agents then treat elapsed time as progress. We need durable
guarantees that:

1. The **fleet substrate** can run N benches in parallel with **zero INFRA**.
2. The three Cloud Fleet run shapes `/descend` exposes actually work:
   sequential (`campaign_cap=1`), lane max-concurrency (`campaign_cap=N`), fully
   parallel (multi-task fleet).

## Recommendation

**Do not** use `test-mass-agent-run-0` (50-child fanout) as either proof.

**Do** this:

1. **Fleet infra probe** (`CLOUDBENCH_INFRA_PROBE=1` / `--infra-probe`): N boxes
   run bring-up → synchronized barrier → DONE **without** `run_benchmark` / LLM.
2. **Strict barrier** (`--strict-barrier`): canaries fail closed on any exclusion
   (tolerant barrier remains default for wide capability fleets).
3. **`/descend` epoch-0 `FLEET_INFRA_CANARY`** before first `RUN_SLICE`.
4. **Small DEMO tasks** (`demo-fleet-alpha|beta|gamma`, execute-phase) +
   `scripts/run-fleet-concurrency-modes` for the three concurrency shapes.
   Workflow `fast_mode_cache_enabled` uses `is_demo_cache_task` (catalog DEMO
   hashes), not only mass-agent OAI prefixes, so cold soft-complete can
   COMPLETE at $0 without expanding mass-agent-only spawn rules.
5. **`/deploy` Step 6d** runs infra canary + DEMO concurrency e2e **alongside**
   local smokes.

## Definition of done

- `bash scripts/run-fleet-infra-canary [N]` (default N=4) samples **real
  unified-catalog names** (not fake `infra-canary-$i`), exits 0 only when
  ready==N, exclusions==0, every box DONE, teardown clean.
- `bash scripts/run-fleet-infra-stability-proof` runs **10 sequential fleets ×
  20 parallel catalog-sampled tasks** under `--infra-probe`, fail-closed on the
  first INFRA / non-zero exit. `--dry-sample` pins sampling without Fly.
- `bash scripts/run-fleet-concurrency-modes --dry-contract` exits 0; live modes
  use only `demo-fleet-alpha|beta|gamma` (`fast_cache:on`, no browser / code /
  mass-agent fanout) so deploy DEMO concurrency stays **$0 cache**.
- Structural tests pin probe + strict-barrier + DEMO + stability-proof contracts
  without live Fly.
- **Runtime guarantee (required):** `scripts/run-bench-fleet` refuses to
  provision a multi-bench capability fleet unless
  `.context/fleet-infra-canary.last-pass` is fresh (TTL
  `FLEET_INFRA_CANARY_TTL_SECONDS`, default 3600); otherwise it runs
  `run-fleet-infra-canary` N=`FLEET_INFRA_CANARY_PREFLIGHT_N` (default 2) with a
  distinct controller lock and fail-closes on INFRA. This protects `/descend`
  even before command-doc wiring merges.
- `/descend` documents epoch-0 `FLEET_INFRA_CANARY` + the three Cloud Fleet
  shapes (sequential / lane / parallel) with explicit recipes + distinct lane
  controller locks (command-wiring PR; soft-skipped in structural tests until
  present).
- `/deploy` Step 6d documents infra canary + DEMO concurrency live gates at
  **$0** cache cost, running **alongside** smokes (near-zero deploy wall-clock;
  command-wiring PR).

## Anti-goals

- Do not mint 50 DEMO catalog clones.
- Do not weaken tolerant barrier for ordinary wide capability fleets.
- Do not rewrite #1285's rolling-lane supervisor in this PR.
