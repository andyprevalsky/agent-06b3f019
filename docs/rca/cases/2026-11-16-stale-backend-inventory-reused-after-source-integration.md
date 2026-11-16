---
id: 2026-11-16-stale-backend-inventory-reused-after-source-integration
date: 2026-11-16
title: Reusing the pre-integration backend gate template omitted two new domains and blocked execution
surface: harness
component: deploy-backend-inventory
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/deploy_test_plan.py::main loaded an explicitly supplied pre-integration template with 283 backend checks after source integration added two domains; the worker inventory guard correctly rejected the request"
symptoms:
  - "DEPLOY_BACKEND BLOCKED: backend case inventory does not match the frozen domain list"
  - "DEPLOY_GATE_WORKER_EXIT 2"
  - "remote run ended without a worker result"
  - "283 checks UNVERIFIED before any backend assertion ran"
tags:
  - deploy
  - source-integration
  - stale-template
  - backend-inventory
sources:
  - PR #2290; occurrence 7b33c85d1bb84de19fc123a34bb24ff2
  - commit 96d12280d3438f764b0c098ab4f9547eb763b3fd; prior commit 1771c166ad8e5654a448d38bdf19e3dce0a1cc0b
  - task GitHub Actions run 43831930810; job 133179058815; artifact 14209690030
  - task private evidence /tmp/rca-118fff32-96d-backend-rca/receipt.json
repro: "/tmp/rca-118fff32-96d-backend-rca/replay.py (private captured-request AST guard replay; no test suite execution)"
status: fixed
---

## Problem

The required `backend-coverage-blackbox` gate in final attempt 20 did not run
its backend tests. Its controller reported failure with 283 checks UNVERIFIED,
while the GitHub job itself was green. This was not 283 assertion failures.

The exact launcher command was:

```text
/home/boxes/rose/agents/venv/bin/python3 /home/boxes/rose/scripts/deploy_test_github.py --runner blacksmith-16vcpu-ubuntu-2404 --worker-script deploy_test_backend.py --worker-root /home/runner/_work/rose/rose --deadline-seconds 14400
```

The remote log's first error at 2026-11-16T08:32:08.885685Z was
`DEPLOY_BACKEND BLOCKED: backend case inventory does not match the frozen domain list`.
The worker exited 2 before writing `result.json`. The remote wrapper intentionally
returned 0 so it could upload failure evidence. The controller then emitted
`remote run ended without a worker result` and exited 1.

## Diagnosis

Source integration brought `github-user-credential.blackbox.ts` and
`rose-import.blackbox.ts` from main. The previous source had 283 selected checks;
the integrated source had 285, including four fixed coverage/cleanup checks and
excluding `integration-health`, which belongs to live probes.

The coordinator prepared a new source-bound plan using an old `--template`.
Its retained template, prepared plan and actual remote request all carried the
same old 283-check list. `deploy_test_plan.py` correctly loads an explicitly
supplied template; its normal `standard_template()` instead reads the current
filesystem inventory. Rebinding source identity did not regenerate the supplied
case list. The worker's unchanged `_execute` inventory guard correctly refused
the omission before backend setup or test assertions.

**Gate: INTRODUCED**, through this deployment's source integration and stale plan
preparation. The worker, GitHub adapter and planner code were unchanged between
the compared sources. No stale Prisma client, provider quota or external outage
was demonstrated. The original paused RCA agent was not involved or modified.

The private replay executes the actual inventory-guard AST using the captured
request and each revision's Git file inventory. It substitutes no test results:

| Source | Request inventory | Guard result |
| --- | --- | --- |
| Prior `1771c166ad8e` | Captured 283 | PASS |
| Prior `1771c166ad8e` | Refreshed 283 | PASS |
| Integrated `96d12280d343` | Captured 283 | Exact native inventory error |
| Integrated `96d12280d343` | Refreshed 285 | PASS |

The replay command exits 0 because it asserts this red/green matrix. A passing
guard is only admission proof, not a passing 285-check backend suite.

Archive searches used the actual symptoms: `backend case inventory does not
match the frozen domain list` and `remote run ended without a worker result`.
No same-cause case was established. The returned
`2026-10-02-controller-clone-fixtures-omitted-native-inventory-admission` is a
relative about faithfully supplying a caller's inventory, not stale deployment
selection. `2026-11-09-github-liveness-quota-wait-starved-result-channel` is a
relative of the generic missing-result symptom; its quota/result-polling cause
does not apply because this worker explicitly rejected the inventory.

## Solution

Operational plan repair; no runtime code change is needed. After each source
integration, use the existing deploy-gates standard-template preparation and
worker binding path rather than passing the old template forward. Preserve all
selected gates and regenerate their source-bound case recipes together. Never
add skips, relax inventory validation, or edit only the request to bypass it.

The parent prepared the existing supported full template and bindings in
`/tmp/rca-118fff32/plan96d-repair/`. Its `proof.json` shows exactly one inventory
change: backend 283 to 285, adding the two named domains, while all 17 gates are
preserved. The parent reports `preserve_contract` and `validate_recipe` passed
for all 17. This preparation has not been promoted to the canonical plan and
has no full-suite execution credit at this case's drafting time. After healthy
siblings finish, the parent must triage the original unverified receipts,
perform the coherent native refresh, and run the full required backend gate.
Keep this case open until that outcome is recorded.

This uses existing coordinator preparation and adds no per-agent runtime work,
state, polling or scalability cost. No new tooling abstraction or test mirroring
the inventory concatenation is proposed.

## Evidence and recovery

Private packet: `/tmp/rca-118fff32-96d-backend-rca/`. It contains the complete
native job log (`gh-log.out`), original request/timing/bundle artifact,
controller receipt, retained template, prepared plan, replay and its result.
The downloaded GitHub artifact digest is
`5eec8f7b38da3a44f8c1941da824e9c55b29fb2d3474c00997a0626659c0c018`.
The source digest is
`0370c1f07dd96fdd761f8bf56d7923ef2ddaf4fe88c9ec44f44efbe1d87a50b2`.
Per-file SHA256 bindings are in the private receipt and records-prep manifest.
Do not commit raw traces, credentials or signed download URLs. Preserve this
packet through the existing encrypted private archive before workspace deletion.

### Landed qualification (2026-11-16)

The parent promoted the coherently regenerated standard template and bindings
after healthy siblings completed. The actual full backend gate then passed all
285 checks, and all 17 final native gates passed on 96d12280 before PR #2290
merged as cc7a39b2846aa385320386bbb1374e74c989e6a4. The original 283 UNVERIFIED
results remain historical failures of admission, not test failures. This closes
the operational inventory repair without a runtime code change or guard waiver.

## Human feedback

The user requested RCA and classification for agent 118fff32, with all approval
requests handled by the main agent. The supplied standing instruction protects
Freedom. The parent chose to leave the original root untouched and keep healthy
validation jobs running while investigating this incidental failure; these are
coordination constraints, not additional human feedback. No further human
correction is recorded here.

## Reusable lesson

A source rebind is not an inventory refresh. After integration adds test files,
prepare the standard gate template and bound recipes from the integrated tree
before running the frozen plan.
