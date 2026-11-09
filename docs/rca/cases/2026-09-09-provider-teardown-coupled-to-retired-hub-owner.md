---
id: 2026-09-09-provider-teardown-coupled-to-retired-hub-owner
date: 2026-09-09
title: Provider teardown required a retired Hub owner to match its replacement process
surface: infra
component: cloudbench-fleet-teardown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet fleet_audit_finalize_provider_teardown required cloudbench_central_hub_owner_matches after the recorded Hub PID birth had retired
symptoms:
  - "❌ durable fleet teardown manifest is incomplete"
  - fleet_audit_finalize_provider_teardown returns 1 at cloudbench_central_hub_owner_matches
  - original Hub PID birth is absent while the same port serves a replacement Hub
tags:
  - cloudbench
  - fleet
  - teardown
  - hub
  - pid-birth
sources:
  - commit 6c1bd8bfaa9ba6677e10f3f438b878c1d88f6e00
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

Stale Fleet recovery destroyed both recorded Fly machines, verified them absent,
and released every pool claim, but the controller still exited 1 with
`❌ durable fleet teardown manifest is incomplete`. Xtrace placed the only
failure in `fleet_audit_finalize_provider_teardown` at
`cloudbench_central_hub_owner_matches`: the audit named the original Hub birth,
while its port now served a later replacement birth.

The deterministic pre-fix command
`CLOUDBENCH_TEST_STALE_HUB_REPLACEMENT_SELF_TEST=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`
exited 1 with `FAIL: provider teardown must finalize after its exact Hub birth
retires`. Its fixture contained two `destroyed-verified-absent` machine records,
an empty claims directory, an absent original Hub birth, and a live replacement
on the same port.

## Diagnosis

Critical path: stale registry recovery → audit-only clone reconciliation →
provider reap → exact pool-claim recovery → provider-audit finalization → Hub
ownership classification.

The first bad boundary was the final step. The normal-worktree branch always
called `cloudbench_central_hub_owner_matches`, which requires the recorded PID,
birth, token, and endpoint metadata all to be live simultaneously. Once the
original exact birth retired, a valid replacement endpoint necessarily failed
that check even though provider teardown was complete.

The deepest owned cause was a lifecycle-contract inconsistency: one terminal
provider-resource audit was coupled to the current liveness of a separate,
replaceable Hub process and had no state for "the exact historical Hub owner is
verified absent." Provider residue and pool-claim residue were rejected by both
the production trace and the deterministic two-machine/zero-claim fixture. This
is a relative of the 2026-07-19 Hub-port collision case, not a recurrence: both
require identity rather than port inference, but this failure happened while
terminalizing a known historical owner rather than selecting a Hub.

## Solution

`scripts/lib/cloudbench-env.sh` now classifies a tracked PID birth as `live`,
`absent`, or fail-closed `unknown`. `scripts/run-bench-fleet` validates the Hub
identity captured in the immutable audit snapshot and uses that single source
for finalization. A live exact birth must still match its owner file and endpoint.
An absent or numerically reused birth transitions to
`retired-exact-owner-verified-absent` without dereferencing or signaling the
replacement process.

The permanent regression covers both a different replacement PID and explicit
numeric PID reuse with an older birth, while proving the replacement stays live
and identity-matched. The unchanged focused regression and the full
multi-workstream suite pass. At 10,000 agents, this adds one targeted `ps`
classification per Fleet finalization, no per-agent work, shared channel, lock,
poller, or provider query.

## Human feedback

The user required an unchanged pre-fix/post-fix regression on latest main,
preservation of the live replacement process, no benchmark task/prompt/timeout
changes, no mutation of registry `a6f5`, and removal of temporary instrumentation.

## Reusable lesson

Terminalize each resource family from its own immutable identity and lifecycle; never require a retired process to match the replacement currently occupying its port.


## Recurrence — historical isolation audit after authorized Hub retirement (2026-11-09)

Native image activation on eb7c60cac0ed05b2bc2778d0fb4ef9888a8a2d52 stopped before intent or setup mutations. historical_debt_audit called inherited_native_sources, whose round12-style validator required the old Hub PID1793380 to remain live and raised FileNotFoundError on /proc/1793380/stat. The six old Hubs had been explicitly retired by the native pidfd producer on November8; their owner files and failed native results were retained. This is the same lifecycle mismatch at a historical-proof consumer, rather than the earlier provider-finalization caller. The newer consumer did not compose the existing absence classifier with authenticated retirement evidence.

Gate: NOT_INTRODUCED by the latest ESLint-only integration. The legacy live-owner predicates were unchanged. This attribution does not waive the failed activation or authorize reconstructing old services. The original read-only audit reproduced the exact exception with network calls forbidden. The corrected same audit returns the exact seven unchanged entries and empty historical source credit. A second exposed f87 ancestor used the same live-only assumption and receives the same narrowly scoped composition.

The composed historical path validates the exact retained November8 retirement packet and producer hashes, matches the original owner path, complete owner bytes, PID and birth, and requires terminal no-credit retirement plus current native process absence. The existing retired_local_process check is reused; the original current scope scan must still find no replacement or unreadable process. Normal direct live-owner validation remains unchanged. Private composition flags are supplied only by inherited_native_sources, after its existing original debt and current-authority guards; no JSON/operator flag or generic live-check fallback is introduced. Every original receipt, pin, source, ancestry edge, failure, cleanup=false and credit=false field remains unchanged. Missing/forged retirement, modified owners, active replacements and ordinary unsupported contexts refuse.

Focused compatibility/retirement tests and the full owning maintenance suite are recorded in .context/cli-nov09-native-activation-0103/rca/result.json, together with exact original/native logs and read-only seven-entry replay hashes. No provider query, resource mutation, Hub restart, database action or canonical edit occurs. Parent instructions require independent review and parent-owned integration/current native validation. The original activation failure remains retained; this repair grants no old execution, cleanup or financial credit. The recurrence remains pending that review and native validation.
