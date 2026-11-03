---
id: 2026-10-13-rose-cache-store-log-ignored-write-ack
date: 2026-10-13
title: Rose cache reported rejected DEMO writes as durable stores
surface: agents
component: rose-client-fast-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseClient.complete and cached_complete emitted llm.cache.stored after cache_set returned False
symptoms:
  - "llm.cache.stored"
  - "fast_cache.set_skipped_demo_namespace"
  - "Run13 DEMO cache 0 hits / 956 lookups with 415 logged stores"
tags:
  - fast-cache
  - demo
  - world-model
  - persistence-ack
sources:
  - PR #1453
  - commit badbbc2b31dc1c09ff84c20101e085cd8875b313
  - commit cfc294282
  - agent 882b536f-5210-4c83-bf10-f2b4ce034228
  - agent 65889659-9f08-4488-917e-9611223be811
repro: agents/tests/blackbox/fast_cache_client.blackbox.py
status: open
---

## Problem

The unchanged `raise-5m-rose-labs-brex` Run13 simulation had zero DEMO replay
hits in 956 LLM lookups: 540 native WHM and 416 agent lookups. The native log
reported 415 `llm.cache.stored` events, but every one had a matching
`fast_cache.set_skipped_demo_namespace` event for the same exact key. The
owned local cache table was empty. Original Run12 likewise had 116 native
misses, 107 reported stores and 107 explicit skips. Those original records
remain immutable; only their derived report was qualified.

The completed run is visible at
`https://www.roselabs.ai/?agent-id=882b536f-5210-4c83-bf10-f2b4ce034228` through
its existing verified share grant. Its 60-minute execution window failed the
fundraising evaluator. This case establishes the cache mechanism only and does
not claim a cache repair will make the round complete.

Runtime evidence: Run13
`.context/wmh-resume-generation1/run13-flash-azure60m/wmh-serve.final.log`;
original Run12
`/home/boxes/whm-originals-generation1/original-runtime/rose-wmh-resume/.context/wmh-resume-20261009/fundraiser/run12-messaging60m/wmh-serve.final.log`.
The read-only population audit is
`.context/whm-migration/rca-20261013/cache/run12-run13-key-audit.json`.

## Diagnosis

Critical path:

```text
recognized DEMO root -> native cache context -> exact request key -> cache read
  -> miss -> valid Rose completion -> cache_set -> frozen namespace rejection
  -> False -> Rose wrapper emits "llm.cache.stored"
```

Both cache entry points ignored the return value of the existing write API.
The API correctly rejected a frozen DEMO namespace without the deliberate
`FAST_MODE_CACHE_RECORD_DEMO` flag. The first incorrect data was the success
event after a negative acknowledgment, rather than the catalog decision or
the frozen-write guard. The same defect concealed a backend HTTP 503 rejection;
this is why the fix belongs at the write-result consumer rather than by
loosening the recording policy.

The native context intentionally attempts to record successful predictions;
its `should_write` property is not proof that the store accepted the write.
The generic agent context separately honors frozen recording/read-only policy.
The Fast Mode provider-speed button being off does not disable DEMO reads.

The original native logs contain no `fast_cache.get_failed` or
`fast_cache.get_error` events. Run12 had 116 unique miss keys. Run13 had 535
unique miss keys: 530 appeared once and five appeared twice. The cross-run
exact miss-key overlap was **zero**. Run12's apparent stores supplied no
recording, and no observed native Run13 request had an identical Run12 miss
key. Automatic fast continuation therefore had no demonstrated compatible
native recording to consume.

Native replay intentionally binds correlated call IDs, state/history clocks,
the immutable policy and behavior-shaping inference configuration. It removes
only action-envelope invocation time and the provider's session affinity
hint. The Flash/Azure/filter configuration changed the execution identity;
the prepared JSON mode changes it again. Removing these distinctions to force
hits could replay a distribution for a different action or world and is not a
valid repair. Three existing owning key tests prove call-ID/state/policy
isolation and the permitted timestamp normalization. The population audit
does not attribute every individual key difference to one specific field or
claim to have queried the entire historical shared cache.

Archive searches executed:

1. `python3 scripts/rca_archive.py search 'fast_cache.set_skipped_demo_namespace llm.cache.stored'` — no match.
2. `python3 scripts/rca_archive.py search 'DEMO cache zero hits frozen read only recording'` — relatives
   `2026-09-27-general-demo-cache-gate-was-never-loaded-by-workflow` and
   `2026-10-05-demo-replay-probe-live-fallback-before-cache-context`.

Their solutions and human feedback were read. This is a new acknowledgment
defect, not a recurrence of their catalog-resolution or no-live-fallback
boundaries; actual native reads and misses were present here.

Golden reference: `claude-code-src/src/utils/statsCache.ts:240` awaits its
atomic rename before logging successful cache persistence;
`claude-code-src/src/utils/model/modelCapabilities.ts:107` awaits its write
before reporting cached models. The acknowledgment-based Rose correction
converges on that pattern. Searches for cache writes/saves, replay and cache
success events in the available OpenClaw, Hermes and Codex source found no
matching DEMO completion-replay/write-ack API; their token-cache metrics or
in-memory connector caches are not substituted as proof of persistence.

## Solution

The already prepared `cfc294282` follow-up consumes `cache_set`'s boolean in
both `RoseClient.complete` and the compatibility wrapper: accepted writes emit
`llm.cache.stored`; rejected writes emit `llm.cache.store_skipped`.
The existing isolated WHM helpers explicitly enable deliberate DEMO recording
in their own native/task processes. Shared global frozen policy is unchanged.
Run13 executed the earlier source and did not receive those changes mid-run.

This investigation promotes the actual boundary regression into the permanent
`fast-cache-client` blackbox, using the real native context, recognized unchanged
task prompt, actual frozen-write predicate and real `cache_set` HTTP response
handling. Only the external model stream and cache backend are controlled.
Both central and compatibility paths cover frozen rejection, HTTP rejection
and a legitimate exact-key write/replay with the provider-speed button off.
The assertions and test bytes are identical before and after the correction.

From the resumed repository with the pinned agents environment activated:

```bash
python .context/whm-migration/rca-20261013/cache/run_owning_boundary.py badbbc2b31dc1c09ff84c20101e085cd8875b313
python .context/whm-migration/rca-20261013/cache/run_owning_boundary.py
```

The first command loads the exact two historical completion entry functions
from Git into the same permanent fixture; it does not replace shared source
files. Baseline: **four failed, five passed**, exit 1, about 1.1 seconds;
failure assertion: `Rose reported a stored response without an accepted cache
write`. Corrected source: **nine passed**, exit 0, about 1.1 seconds. Private
outputs are `blackbox-baseline.log` and `blackbox-fixed.log` in that same cache
RCA directory. The normal agent runner discovers the registered cases in
`fast-cache-client`; `/deploy` Step 4g executes that blackbox through agent
coverage. The root investigator owns integrated validation and adversarial
review after the parallel issue edits settle.

Existing native key invariants passed unchanged:

```bash
python -m pytest agents/benchmarks/wmh_rose_provider_test.py -k 'native_cache_identity_preserves_correlated_call_ids or distribution_cache_keys_bind_exact_action_state_and_policy or native_cache_fingerprint_changes_only_current_action_timestamp' -q
```

Result: **three passed, 112 deselected**, 0.60 seconds. No external model call,
paid benchmark, global policy change, cache mutation, prompt/fixture/evaluator
edit, deploy or merge was performed. The worker's initial Ruff command found no module in the pinned agents
environment. The root then used isolated Ruff 0.17.0 through `uvx`, preserving
the runtime environments; both changed Python test files pass lint. The full
registered `world-model-harness fast-cache-client` runner passes both domains
in 16.5s, including 59 native and 207 provider/reliability cases.

Simplification check: the cache API already provides one authoritative boolean
for both entry points. Deleting its rejection policy would permit unreviewed
DEMO writes; deleting its success report would hide accepted persistence. The
correction consumes that existing truth instead of adding state, another
persistence path or a second recording policy.

At 10,000 agents the acknowledgment correction adds a constant-time branch
per attempted write and no new query, global counter, polling, lock or state.
The new offline fixtures add no production overhead.

The cache mechanism is causally proven, but this benchmark case remains
**open**: the exact unchanged fundraiser was not rerun on the corrected source
under a new paid approval, so its end-to-end replay coverage and fundraising
outcome are not proven. Deliberate recording cannot guarantee future hits when
execution identity, call IDs or state differ. Do not count an upload receipt,
write attempt, cache token metric or mocked replay as an exact task success.

## Human feedback

The user asked for DEMO cache, agent prompt-cache and WHM prompt-cache rates
separately, and expected DEMO replay to accelerate the new 60-minute iteration.
They later asked to tackle each issue with a sub-agent and `/rca`. Existing
instructions prohibit a new paid trial without approval and prohibit merging,
deploying or changing unrelated harness behavior.

The user explicitly approved DEMO cache reporting on 2026-10-13. The
acknowledgement correction and its registered regressions remain applied; no
cache-key or global frozen-policy relaxation is included.

## Reusable lesson

Report replay persistence from the accepted write acknowledgment and preserve exact behavior-bound keys when recording an isolated DEMO trajectory.

## Run14 recurrence at the backend acknowledgement (2026-10-13)

Run14 source `c3a575907c3f8f3969307c9165c56ffb999fba13`, root
`f1f436c9-8c1e-43a9-bf25-d4613c94e441`, finished naturally after 3691.4s
with the unchanged fundraiser failing its 3600s execution window. DEMO was
enabled with explicit recording, but all 153 native `llm.cache.stored` keys
exactly matched all 153 backend `fast_cache.write_skipped_read_only` keys,
with no unmatched keys. The owned precutoff DB dump contains zero cache rows.
There were zero replay hits in 226 lookups (155 native and 71 agent).

The prior Rose consumer correction was present. A deeper acknowledgement
boundary remained wrong: backend `cacheSet` skipped read-only writes and
returned void; the route returned HTTP200 `{ok:true}`; Python treated HTTP200
as successful persistence. Original response bodies were not captured. The
body shown here comes from an executed immutable-source causal control, not
a reconstruction of original Run14 HTTP bytes. The local benchmark also
forced the explicitly selected recording cache read-only and tied its data
to a resettable fixture. Shared read-only policy itself remains correct.

Identical real Express/auth/store → HTTP → Python owning assertions fail
original source and pass the candidate. See
private `run14-grounded-retry60m/rca-cache/result.private.json` for each
measured command and source hash; its own original reporting control is
1.330s FAIL and candidate 1.246s PASS. The correction adds authoritative
`stored` acknowledgement while preserving the void wrapper for other proxy
callers. Python requires explicit `stored:true`. This reports successful
persistence only after the actual Prisma operation, without an extra query.

The recording integration opts in only through explicit owned-store selectors
on isolated simulated fast-cache tasks with RECORD_DEMO. A private owner
receipt binds the retained loopback `victoria_wmh_recording_*` database to the
actual checkout and iteration workspace, separately from the fixture DB.
No selectors preserve existing behavior; partial or wrong selectors fail
closed. Shared/ordinary/non-simulated runs preserve their existing policy.
Correlated call IDs, native request fingerprints, state/policy identity,
validation, sample-once/replay keys and prompts remain unchanged.

The actual registered backend fast-cache domain passes (5.882s). Registered
agent fast-cache-client and world-model-harness domains pass (33.9s), with
13 new owner admission/isolation cases separately passing (0.14s), registered
in the native provider suite. Root owns final integration verification and
exact unchanged next-trial outcome; no benchmark pass is claimed here.
At 10,000 agents acknowledgement adds a boolean and constant-time check,
not a second persistence ledger. The owner receipt is read once per stack.

The user explicitly approved cache reporting and now requests a repeating
60-minute DEMO-on trial, per-cluster subagent RCA, then scorecard/approval
cycle. This authorizes owned recording and the next trial; it does not
authorize key masking, prompt changes, fixture alteration, merge or deploy.
Run14's private original results and 71 LLM dumps are authenticated in the
nonsecret receipt `docs/handoffs/whm-b07d9037-preservation/run14-grounded-retry60m.json`.
The cache/fundraiser case remains open until actual new-run replay coverage
and task outcome are observed.


## 2026-10-15 success-fixture consequence

The integrated deploy's existing `test_fast_cache_archive_uses_resolved_root_agent_id` still mocked HTTP200 `{ok:true}` without the persisted `stored:true` acknowledgement required by the corrected runtime. Its unchanged `ok is True` assertion failed. The fixture now returns `{ok:true,stored:true}`; the production client is unchanged. All 36 registered archive cases passed in the private candidate (5.36s), including unchanged `stored:false`, HTTP503 and transport-error controls. This is a stale success fixture, not a recurrence of the runtime acknowledgement bug. Candidate SHA256: `4478f8d3b0c989381e392a4433e6cdf81621da77359a298ac210fa76a2377f38`.
