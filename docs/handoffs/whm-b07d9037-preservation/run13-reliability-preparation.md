The original user authorized one new 60-minute `raise-5m-rose-labs-brex`
simulation after requesting WHM reliability changes. No merge or deployment is
authorized. The unchanged catalog task, full-history Tamy fixture, original
per-run state override and recovered native artifact are retained.

WHM inference now uses RoseClient.collect with the `rose-1-flash` pool.
`WMH_AZURE_FIRST=1` prefers the pool's Azure Foundry model, then Cerebras;
the existing pool waterfall remains available. `WMH_INFERENCE_POOL` selects the
inference pool separately from the original artifact's `WMH_ROSE_POOL` pin.
`WMH_EXCLUDE_FAILED_TOOL_EXAMPLES=1` excludes failed retrieved tool-result
demonstrations before native prompt packing and protocol repair. It does not
delete live errors, enforce successful outcomes or alter researched examples.
All three settings are bound in the runtime execution identity and recorded in
health, predictions, retirement and run evidence. The original policy and native
artifact descriptors remain unchanged. Separate conformance binding is prepared;
no paid conformance evaluation was performed.

Partial provider errors are recoverable only for explicitly collected WHM whole
results. A retry discards abandoned partial output, skips its model, retains
known metering and respects the existing Rose call deadline. Incomplete abandoned
usage is marked incomplete. Ordinary callers keep their routing, cache material,
partial-error behavior and activity deadlines. Opt-in routing creates distinct
DEMO cache material.

WHM-bound email/SMS/iMessage, notification and specialized-agent activities no
longer have short StartToClose deadlines. Temporal requires a scheduling bound,
so these activities have a one-year ScheduleToClose bound with run-owner
cancellation. The authorized 60-minute benchmark cutoff, session retirement and
exact-owner cleanup remain. WMH step socket reads also wait for owned native work;
control requests retain finite HTTP timeouts. This addresses the demonstrated
caller budget mismatch without claiming a live causal repair or fundraising pass.

Validation: world-model-harness, Rose (224 cases), fast-cache-client,
message-person, spawn-agent, workflow and workflow-determinism (5 cases) pass.
The WMH gate includes 58 native Python 3.12 cases and 194 provider/initial-state/
clock/wire/vendor cases. The recorded original eight sampled explore errors still
replay exactly with zero real service or model calls. The same delivery scheduling
audit now has no per-attempt deadline and covers both original 130.745s and
181.043s native sends. The native integration test preserves sample-once replay,
live failures, shared state and negative business outcomes while excluding failed
demonstrations before packing and repair. An original-record scan found 70 failed
tool-result appearances among 555 examples in 116 canonical requests, with
485 retained; scanning the first canonical evidence message includes repair
records that a last-message-only scan misses.

The frozen fixture contains 42,910 Tamy messages: 23,130 iMessage, 10,593 email
and 9,187 WhatsApp. `SEED_MESSAGE_LIMIT=100000` remains enabled. Its DEMO cache
table contains zero rows. The original benchmark DB was deleted by canonical
cleanup, so no previous Run12 cache bytes are claimed as available. The rerun has
DEMO read/write enabled in its own DB; cache identity checks are preserved.

At 10,000 agents the new code adds no shared lock, fan-in, polling, network call
or DB query. Filtering is linear in the bounded retrieved top-k; routing adds
at most the existing bounded fallback attempt on explicitly opted-in replies.
Long-running activities retain per-operation idempotency and run cancellation.
The existing RCA stays open until its outcome gate is met. No additional review
agent was launched under the user's no-new-agent instruction.
