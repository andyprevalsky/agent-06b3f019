---
id: 2026-09-12-autoscaler-observed-artifact-collector-after-guest-exit
date: 2026-09-12
title: Autoscaler metrics observation continued through artifact collection after guest shutdown
surface: infra
component: cloudbench-autoscaler-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: bench_autoscaler used full collector exit as its only terminal boundary after the guest had acknowledged cleanup and exited
symptoms:
  - "metrics returned no valid desired_machine_count for 6 consecutive polls"
  - "guest cleanup ACK precedes autoscaler failure and benchmark-child.finished"
tags:
  - cloudbench
  - autoscaler
  - metrics
  - artifact-collection
  - shutdown
  - ownership
sources:
  - PR #1299
  - commit e706019a625e0009d9758446f107762f29a7a234
  - fleet run capability-stability-20260912201842-35760
  - fleet run 20260912-131843-36480
  - plan: docs/plans/completed/cloud-bench-per-bench-isolation.md
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_autoscaler_runtime_handoff_preserves_collection_and_capacity
status: open
---

## Problem

Proof18 completed its mandatory two-task canary and started all ten actual
benchmark roots with the unchanged 300-second backstop. All ten made real model
and tool progress and produced native benchmark FAILED outcomes, which are
allowed by the user's infrastructure-only acceptance contract. Three mandatory
autoscalers nevertheless exhausted six missing desired-capacity polls. The
attempt remains failed with zero accepted slices.

The affected tasks were `parallel-tool-calls`,
`polar-odysseys-2dab64ba576a`, and `polar-odysseys-4246dec196c9`.
Their guest drivers had already acknowledged stack cleanup and exited; the local
controllers were still collecting complete artifacts. The autoscaler required
metrics until that longer-lived collector exited.

## Diagnosis

The critical path is task/root cleanup → guest result emission → stack shutdown
→ boot supervisor cleanup ACK and exited state → complete local artifact
collection → actual `benchmark-child.finished` → autoscaler finalization.

| Task                        | Guest ACK/exited (UTC) | Autoscaler failure file (UTC) | Actual child marker (UTC) |
| --------------------------- | ---------------------- | ----------------------------- | ------------------------- |
| parallel-tool-calls         | 20:42:56               | 20:43:56.494                  | 20:44:05.997              |
| polar-odysseys-2dab64ba576a | 20:42:27               | 20:43:24.446                  | 20:43:31.778              |
| polar-odysseys-4246dec196c9 | 20:42:57               | 20:43:56.472                  | 20:43:59.664              |

The three guest-seal-to-child tails were approximately 70, 65 and 63 seconds;
the seven healthy siblings took approximately 6–35 seconds. Guest logs have
whole-second UTC precision and the local files use the controller clock. These
observations establish ordering, not precise cross-host elapsed milliseconds.
Individual scrape responses and timestamps were not captured, so the first
missing poll cannot be placed exactly. Temporal namespace warnings are not
established as the cause. Native task quality is outside this investigation.

Archive searches were `metrics returned no valid desired_machine_count` and
`autoscaler after child completed metrics shutdown`. The
[serial recording publication case](2026-09-11-recording-archive-serial-publication-outlived-worker-drain.md)
is a relative: publication there delayed guest driver exit itself. Here the
retained driver exits before the long collection tail. The
[post-child worker ledger case](2026-08-03-post-child-worker-ledger-contention-treated-terminal.md)
is another relative; its bounded readiness reconciliation remains necessary.
This evidence does not establish a regression in recording batching or worker
ledger locking.

The first local replay runs the actual unchanged autoscaler, child supervisor
and canonical status server with controlled metrics, inventory and Fly proxy
boundaries. An authenticated current-run cleanup ACK and exited state produce
HTTP204. Immediate collector exits 0 and 1 pass; holding either collector alive
causes the exact six-poll failure. Releasing it then produces its correct exit
marker. This four-case causal RED took 19.011 seconds and made no provider or
model calls. It is retained as `replay-before.json` and `replay-before.log` under
`.context/acceptance/proof18-autoscaler-rca/`.

The deeper owning mismatch is that runtime observation and artifact collection
shared one completion authority. `run_fleet_child_supervised` correctly waits
for its child and descendants before publishing their exit. Moving that marker
earlier would discard a real completion obligation. A fleet-wide barrier token
alone also cannot distinguish a valid terminal sibling from the intended
primary, so merely probing any authenticated status port would be insufficient.

## Solution

Pass one owner-derived, per-child run token to both the existing guest launch
and its autoscaler. Extend the existing authenticated GET `/shutdown-health`
with optional paired expected-run and expected-primary headers. When supplied,
both must be canonical and match the status server's actual run token and
provider-injected `FLY_MACHINE_ID`. A shared bearer credential with a different
run, owner or machine cannot return the terminal seal. Legacy cleanup callers
that omit both headers keep their existing contract.

After a valid desired-capacity observation, missing metrics may trigger this
bounded read through the existing status proxy. Only a matching HTTP204 can end
runtime metrics decisions. It does not request shutdown, infer completion from
HTTP410, or trust a cached local marker. The new
`autoscaler.runtime-completed` file records the exact observed token and
machine; it is never read to authorize a later handoff.

Reuse the existing bounded finalizer to reconcile every committed worker and
wait for the actual collector's finish marker. Pending, failed or insufficient
capacity still fails. An absent collector marker at the existing finalization
deadline also fails. `autoscaler.completed-after-child` remains a copy of the
real child exit only, and an earlier autoscaler failure remains fatal. Final
result/provenance, native outcome, evidence, resource and registry checks are
unchanged. The six-poll threshold, task cap, capacity/concurrency settings and
all existing finalization deadlines are unchanged.

This reuses the existing status service, status proxy and capacity finalizer;
it adds no observer process, provider inventory scan or resource. At larger
fleet sizes, the extra work is a single bounded status GET per missing metrics
observation until terminal handoff or the existing failure threshold. It is not
an additional fleet-wide polling loop.

Before the runtime edit, the permanent 29-case selection reported 11 failures
and 18 passing controls. The unchanged selection then passed all 29 in 24.78
seconds. It covers both native exit codes, same-bearer sibling rejection,
missing/partial/malformed identity, stale ACK, missing ACK, active/unknown guest
state, wrong authentication, prior failure, pending capacity, failed/stuck
capacity and an uncompleted collector. The adjacent lifecycle selection passed
56 cases in 28.80 seconds. Commands and logs are retained privately:

```bash
agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k autoscaler_runtime_handoff
```

`permanent-before.log` and `permanent-after.log` contain the paired result.
`adjacent.log` covers existing autoscaler, driver cleanup and status contracts.
The tests are registered in `benchmark.blackbox.py` and the recurring Linux
controller selector in `.claude/commands/deploy.md`.

Independent review additionally reproduced a test-fixture ownership defect:
failure to spawn the second process left the first outside cleanup. Three
permanent no-process fault controls fail before the fixture repair and pass
afterward. They verify second-spawn failure, release-file write failure and a
failed first join; each preserves the original exception and still attempts
cleanup of every admitted process. This is a fixture repair, not the live
incident's cause. The final selection includes these three controls.

Independent final execution passed all 32 cases in 24.60 seconds, and the
unchanged private second-spawn control now confirms one termination and one
join. The final reviewer found no runtime blocker; its receipt is
`handoff-final-independent-review.json` in the same private RCA directory. At
that point live verification remained pending. The later proof19 observations
below validate the repaired boundary, while the complete ten-slice acceptance
remains open. Neither local verification nor a later successful slice turns
proof18 into a successful slice. Exact proof18 cleanup was separately verified for all twelve machines
and volumes, both registries, ten durable bundles and its Hub. Those receipts
are `.context/acceptance/proof18-cleanup-independent/verification.json` and
`.context/acceptance/proof18-hub-retirement.json`; historical lifecycle and
native outcomes remain unchanged.

### Live boundary verification and subsequent controller suspension

Proof19 at `891eadf921d6572ce9a4a821a67b139323549b0e` accepted its first two
slices. The first, `20260913-125235-55066`, independently verified all ten
runtime-to-collector handoffs, including collection tails of approximately
30–80 seconds after runtime sealing. Every autoscaler waited for its actual
child completion, without an early completion marker or autoscaler failure.
All ten roots had at least five successful correlated LLM queries, complete
durable evidence and verified cleanup. This validates the repaired boundary;
the private review is
`.context/acceptance/proof19-slice1-independent-review/final-review.json`.

The complete proof nevertheless failed in slice three. Native power events
record clamshell sleep at 13:06:18 UTC on September 13, inventory expiry at
13:09:14, and eight autoscaler failure markers during the first brief DarkWake
at 13:14:13. Full wake occurred at 18:43:17. The expired inventory health check
was sufficient to produce the message that primaries had disappeared; that
message does not prove native provider deletion. Fresh provider observations
later found the same eight machine instances still present, with exited guest
drivers and cleanup acknowledgements. Earlier transient URL errors recovered
before sleep; their discarded exception details do not establish timeout or DNS
causes. The native timeline, source predicates and exact instance bindings are
retained in
`.context/acceptance/proof19-host-interruption/independent-review/final-findings.json`.

The two historical accepted slices cannot carry into a new ten-slice streak.
Use a continuously running Linux controller for the replacement campaign,
including its collectors, local status proxies, Hub and evidence publisher.
This changes controller placement, not benchmark tasks, model requests,
evaluation, capacity requirements or acceptance rules. Guest progress and
forensic result recovery cannot waive a controller infrastructure failure.

## Human feedback

The user requires ten sequential cloud slices of ten actual tasks without
infrastructure issues. Ordinary task failures are allowed. The user explicitly
limited this work to infrastructure and prohibited changing benchmark behavior
to make tasks pass; the five-minute cap and validation criteria remain intact.

## Reusable lesson

Bind metrics observation to the authenticated workload lifecycle while preserving independent artifact-collection and resource-cleanup completion obligations.

### October 6 fixture recurrence after post-ready observation retries

The final covered benchmark gate exposed seven failures in this case's owning
handoff fixture: missing or wrong ACK, running state, wrong run or owner,
same-bearer sibling, and wrong authentication. The fixture held the original
collector until a release file appeared, made metrics unavailable after guest
sealing, then waited eight seconds for the autoscaler to retire before releasing
that collector. It relied on the former six-scrape infrastructure failure. The
post-ready warning/retry repair correctly leaves both owned processes running
when these invalid seals do not authorize a runtime handoff.

Archive searches for `autoscaler handoff did not resolve` and `artifact collector
guest runtime metrics six poll` identify this case and the October 6 post-ready
observation case. This is a recurrence in the fixture's stage ordering, not a
new production failure. Exact local reproduction on frozen `671b5d70` passes
eight of the unchanged 15 cases and fails these seven in 74.085 seconds. The
corrected fixture runs the same selection and passes all 15 in 27.897 seconds.
All 90 captured native local status-server, supervisor and autoscaler Popen
births are positively absent and their children are reaped. No provider or
benchmark allocation was made.

For the seven invalid-seal cases, cross seven or more missing observations while
the collector remains held. Assert no runtime-completed or child/completed
marker, no autoscaler failure or premature process retirement, and unchanged
zero worker capacity. Then release the actual original child. Its real exit
code remains 1. Once that exact local child finishes, the existing autoscaler
contract may settle with exit 0 and copy the real child exit 1 into
`autoscaler.completed-after-child`; the rejected guest seal still cannot create
`autoscaler.runtime-completed`. Requiring autoscaler exit 1 at this point would
reintroduce the removed observation failure rather than validate ownership.
The remaining eight capacity, prior-failure and collector controls retain their
existing expectations. Runtime code, task outcomes, finalization budgets and
all 15 fixture parameters are unchanged.

The existing permanent handoff family and normal Linux-controller selection
already discover this control. Source hashes, paired native receipts and the
private one-function patch are preserved under
`.context/fresh-claude-grouped50-20261006/runtime-handoff-fixture-packet`.
This proves fixture correctness only; it grants no actual50 acceptance, timing
or cache credit. The historical fleet qualification remains unchanged.
