---
id: 2026-11-14-production-fly-surface-hash-hashed-working-tree-not-merged-sha
date: 2026-11-14
title: Production Fly lane hashed the deployer's working tree, not the merged commit, and refused a successful cutover
surface: harness
component: run-deploy-pipeline-production
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run_deploy_pipeline.py production() `expected = expected_hash or surface_hash(root)` — surface_hash ran scripts/agent_workflow_surface_hash.py over the current working tree instead of the --merged-sha commit
symptoms:
  - Error: Deployment job does not match the expected source surface
  - "[fly] FAIL: Fly lane blocked (production exit 1): monitor-cooperative-cutover.ts --verify failed (exit 1)"
  - monitor-cooperative-cutover.ts --verify failed (exit 1)
  - could not compute the agent workflow surface hash
tags:
  - deploy
  - production
  - fly
  - surface-hash
  - cutover-monitor
  - merged-sha
  - working-tree
sources:
  - PR #2024
  - PR #2028
  - PR #2044
  - commit 5bf22d752b7b6695e294f35bcb1933d309d6dcae
  - commit c728aea7b8c1ff0148c3ea2ad3a2b77ef1e6552d
  - commit be7284063
  - fleet run deploy-agents 43558449152
repro: scripts/tests/run-deploy-pipeline.test.py
status: fixed
---

## Problem

PR #2024's `/deploy` ran `scripts/deploy production` (merged SHA c728aea7b8)
from the canonical checkout still on the PR branch head be7284063. The
deploy-agents.yml run 43558449152 succeeded and its durable job fa5d5d20…
was SUCCEEDED, yet the Fly lane failed: `monitor-cooperative-cutover.ts
--verify` exited 1 with `Error: Deployment job does not match the expected
source surface`. Rerunning from a checkout detached at the merge passed.
Offline: `agent_workflow_surface_hash.py` gives `1160939de2bc` on be7284063
and `533d313d5760` on c728aea7b8; the monitor was handed the former while the
job carried the latter.

## Diagnosis

`scripts/deploy production` → `run_deploy_pipeline.py production --merged-sha
<sha>` (no `--expected-hash`) → `expected = expected_hash or surface_hash(root)`
→ `surface_hash` ran the hash script over the working tree → `cutover_verify`
passed that hash to the monitor as `--expected-hash` → the monitor correctly
refused the job's surface. Every other production check binds to the merged
SHA (`merged_changes` diffs `<sha>^1..<sha>`), but the expected surface came
from whatever the deployer had checked out; deploy-agents.yml computes it on
its checkout of the merged commit. Any main movement between the branch head
and the merge (here: a different agents surface on main) made a correct
cutover look wrong. What made it possible: the default for `--expected-hash`
was implemented as "this checkout" rather than "this commit", and the existing
test always passed `--expected-hash feedface`, so the default path was never
exercised.

## Solution

`surface_hash(root, commit)` now computes the hash the way deploy-agents.yml
does on its checkout of `commit`: it runs the commit's own
`scripts/agent_workflow_surface_hash.py` (`git show`) over the commit's own
`agents/**/*.py` (`git archive` into a temp dir — the walk only reads `.py`
files; `agents/benchmarks/` is excluded exactly as deploy-agents.yml's sparse checkout excludes it), and fails closed (no monitor, no dispatch) when the commit or its
algorithm cannot be read. The monitor's mismatch refusal is unchanged.
Regression: case 9 of `check_production_fly_wait` in
`scripts/tests/run-deploy-pipeline.test.py` runs `production` without
`--expected-hash` from a checkout on a later head with an uncommitted surface
edit and asserts the monitor receives the merged commit's hash (it received the
working-tree hash before the fix), plus a fail-closed case for a merged commit
without the algorithm. Live proof: `scripts/deploy production --sha 4bc487357e
--lanes fly` with a dirty working tree (surface 33e6681b7031) passed against the
live job (a1af4a845f69). 10k-agent behaviour: deploy-time only, one archive of
~25 MB per production run; no runtime path.

**Shipped:** PR #2044, merged as 5bf22d752b (2026-11-15). Post-merge proof: `scripts/deploy production --sha 5156d475 --lanes fly`, run from the PR branch checkout with a dirty working tree (surface 91e2ae867554), verified the live job with the merged hash 60760315cad0 (`fly: PASS`).

**Recurrence before the fix landed:** PR #2028 (2026-11-14) ran its Fly lane from branch head 5e65165e0 (working-tree hash 664c032e5454) against merge ccc17b0348e4 (merged surface f820f8204890 = its deploy job, deploy-agents run 43564272962 succeeded); the monitor refused with the same error, and a rerun from a checkout detached at the merge passed. The fixed `surface_hash(root, "ccc17b0348e4")` returns f820f8204890.

## Human feedback

None recorded.

## Reusable lesson

Bind every production expectation (hashes, diffs, identities) to the merged commit's git objects, never to the deployer's working tree.
