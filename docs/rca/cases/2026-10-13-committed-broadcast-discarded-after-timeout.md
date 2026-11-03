---
id: 2026-10-13-committed-broadcast-discarded-after-timeout
date: 2026-10-13
title: Committed message broadcasts were discarded after an uncertain send
surface: back-end
component: realtime-broadcast
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: supabaseBroadcast removes committed INSERT notifications before sending and permanently discards a failed batch
symptoms:
  - accepted browser lifecycle messages were absent from the selected conversation
  - a timed out broadcast removed its messages from the publisher queue
tags:
  - realtime
  - supabase
  - delivery
  - browser-chip
sources:
  - agent 9a268261-9e28-4ca5-8141-b233db14f8ce
  - PR #1490
  - PR #1495
repro: back-end/src/tests/blackbox/committed-message-broadcast.blackbox.ts
status: open
---

## Problem

The production browser-chip semantic test accepted two browser-start messages,
but its selected conversation continued to show zero chips. Both API writes
returned 201, and both messages existed durably. The user turn had already
completed, so completion backfill had correctly stopped.

## Diagnosis

`POST message → committed Message row → HTTP broadcast queue → Supabase broker
→ selected-agent subscription → lifecycle chip`.

For root `9a268261-9e28-4ca5-8141-b233db14f8ce`, the canonical answer completed
at 01:33:51 UTC. The last selected-detail read was at 01:34:11.842. The two
browser-start writes succeeded at 01:34:15.736 and 01:34:15.901. Their batch
failed at 01:34:19.090 after its existing 2,001 ms attempt timeout. The publisher
had spliced this batch out of its queue and neither retained nor retried it.

This is a demonstrated defect in the HTTP delivery path, not proof that it is
the sole cause of the production UI failure. A read-only production catalog
check at 02:02:43 confirmed enabled Agent and Message triggers calling
`realtime.broadcast_changes`. Actual delivery on that independent path was not
captured. The trace establishes accepted writes and missing UI visibility;
exclusive attribution remains an observability gap.

## Archive search

Searched `supabase broadcast timeout batch dropped` and
`saved messages missing browser realtime update`. This is a relative of the
July one-shot snapshot and stale-token cases, with a different first-bad
boundary. The April INSERT deduplication case is directly relevant to uncertain
send outcomes: successful delivery can precede loss of its acknowledgement.

## Solution

Command, unchanged before and after the runtime repair:

```bash
cd back-end
npx tsx src/tests/blackbox/run.ts committed-message-broadcast
```

Before editing the runtime, the permanent owning blackbox failed because an
accepted-but-unacknowledged committed INSERT was discarded, and a stalled
request prevented another agent's notification from delivering. Its ephemeral
stream no-retry control passed. The first patched run passed these same three
checks. The final byte-identical ten-case artifact passes through the canonical
blackbox runner and passes only one case on baseline `0008aa8de`. These cases
also cement finite capacity, exhaustion, retry concurrency and independent
initial request slots. The same-topic ordering regression failed on the first
parallel candidate (nine of ten passed) before topic leases were added.

Committed INSERTs retain their original message ID and frozen payload in
per-agent FIFO lanes. Transient failures receive at most three sends, each
using the existing two-second request timeout. Permission errors are not
retried. Ephemeral stream events retain their existing one-attempt behavior.
Capacity rejection and exhausted delivery are logged with the owning topic and
message ID. This process-local queue is not a crash-durable outbox and cannot
guarantee delivery through a sustained provider outage.

The frontend claims repeated INSERT notification IDs before any cloud-mode,
stream, message-array or listener side effects. Claims survive a reconnect for
the selected conversation and reset when selection changes. Snapshot-loaded
messages do not seed these claims: their first notification must still settle
the matching live stream. Late browser-start notifications retain the existing
terminal lifecycle precedence.

An additional unchanged reproduction failed before fixing delayed first plan
acknowledgements: old completed plan X cleared a newer plan Y when X's first
successful notification arrived after its retry. Plan settlement now matches
`toolCallId`, as attention settlement already does. The owning INSERT handler
and its existing tests were extracted into smaller modules to satisfy their
existing lint limits; assertions remain intact and the matching-plan fixture
now includes its real tool-call identity. All 32 focused handler/delivery checks
pass after this correction.

The same first-delivery case also affected assistant rows that lack a stream
ID: fallback cleanup removed newer bubbles for the same subagent. A permanent
regression first failed with an empty bubble map. Fallback cleanup now preserves
streams whose producer start time is newer than the persisted message, while
the explicit stream-ID path keeps exact matching. The unchanged regression
passes after that correction. Legacy rows without usable timing retain their
previous cleanup behavior.

Persistence time does not establish ownership when chat turns overlap. The
producer already returns a unique stream ID; backend chat was dropping it when
saving reasoning. New reasoning rows now retain that existing ID for generator,
search-router and escalation output, including repeated searches. The public
`chat-reasoning-identity` blackbox failed all four cases before the writer fix
and passes all four afterward. Existing exact model-request fingerprint replays
also pass: assistant model projections use message text and do not include this
UI identity. No new model call, schema, deadline, channel or query was introduced.
Legacy rows remain subject to the documented timing fallback.

The frontend permanent reproduction is
`front-end/src/tests/blackbox/hooks-lib-insert-delivery.blackbox.ts`; the same
notification scenarios fail on the baseline and pass after deduplication.
This causal proof does not substitute for unchanged semantic outcome proof.

## Scale and remaining verification

There are no extra channels, production database queries, polling loops or
cross-agent topics. Notification queues and retry permits are bounded in
256 accounting shards, with independent per-agent ordering. Each shard admits
at most 128 lanes and 1 MiB of pending payloads. Initial topic queues admit at
most 64 messages/256 KiB; committed queues at most 32 messages/256 KiB. Initial
HTTP concurrency is 64, with batches of at most 100 messages/1 MiB. Each shard
allows four retry requests. A 30-second age bound controls dispatch eligibility,
with explicit age-expiry receipts. Request slots and topic leases release at
the initial HTTP outcome, before the per-agent retry lifecycle finishes.
Linked ready-topic queues avoid scans across agents. The UI retains identities
for only its selected conversation, alongside that conversation's transcript.

On exact runtime head `e797ebb3b`, full backend and frontend coverage, static
verification, all 46 deploy structural gates, five cold seeds, live probes,
eight smoke tasks including the 50-agent load, eight browser flows, real Claude
E2B smoke, and all twenty unchanged latency samples passed. Web-search median
was 2,346 ms and maximum 2,829 ms. Browser and load evidence was published and
verified in fresh browsers with recording checks. Automated PR review was
skipped under the repository exhaustion exception: CodeRabbit spending cap;
one Claude fallback returned an error after one turn, 2,195 ms and zero cost.
Independent adversarial review passed; no substantive automated PR review ran.

Funded production workflow `38335115929` passed all twenty latency samples, but
its two UI attempts failed different realtime outcomes. The first connection
received no application replies despite HTTP 101; a fresh read-only connection
with the same captured join succeeded. The second attempt joined successfully
and acknowledged heartbeats, but received no broadcasts for two accepted
browser-start rows. FIFO timing and batch cardinality place their notifications
in the mixed four-item batch that timed out after 2,001 ms. Per-item send spans
were absent, so that membership is a reconstruction. Enabled database triggers
remain a separate delivery gap; the HTTP publisher is not the sole path.

Main advanced with benchmark infrastructure and cleanup tests during validation.
Merged-tree gates, final exact-head review and production outcome verification
are pending. The original Google session acceptance remains outside the proof
of this delivery repair.

## Regression discovered by the canonical load

The merged-tree smoke evaluators passed all eight tasks, but the canonical
50-agent load exposed forty-six owned capacity rejection receipts on root
`ff82250b-e0e8-4f12-8699-d6b63b425b61`. Its persisted-message burst peaked at
fifty-nine writes per second. Broker sends remained healthy (HTTP 202, roughly
47–133 ms), yet committed requests generally contained one notification and
queue delay grew toward two seconds. This is a regression introduced by the
initial repair: `startHead` serialized every initial notification instead of
batching queued notifications, so the unchanged thirty-two-message bound
rejected normal healthy traffic.

The previous admission tests held a request indefinitely and proved finite
retention, but did not test sustained healthy traffic at the captured cadence.
The permanent public-publisher `committed-message-throughput` blackbox models
sixty writes per second and successful hundred-millisecond responses with the
production request cap. On the unrepaired `ea261931e` runtime it failed in
4.404 seconds, rejecting twenty notifications. The command is unchanged:

```bash
cd back-end
npx tsx src/tests/blackbox/run.ts committed-message-throughput
```

The fix freezes bounded cohorts of queued committed notifications and admits
an entire cohort atomically to the existing dispatcher. Healthy sends regain
batch throughput; uncertain outcomes retry the same IDs and payloads together.
Admission accounts for the dispatcher's per-message overhead and the actual
remaining topic and shard budgets, including ephemeral traffic. One eligibility
clock governs each indivisible cohort, preventing a deadline crossing from
partially sending a cohort and settling unsent notifications.

The final byte-identical six-case artifact fails on `ea261931e` with twenty
rejections (4.336 seconds) and passes on the corrected runtime (1.538 seconds).
It covers captured healthy cadence, mixed-topic retries, byte overhead, age
cutoffs, and same-topic ephemeral count and byte pressure. The unchanged
original ten-case delivery artifact also passes (3.273 seconds). Independent
adversarial review and affected lint, formatting, TypeScript and batching unit
checks pass. Queue capacities, request timeouts and retry limits are unchanged.
Release remains blocked on the full revised-tree gates and a fresh canonical
load without owned delivery rejections. The old-build latency run was explicitly interrupted after the
capacity regression was established; its three measured direct-answer samples
do not count as a completed gate. All four sandbox payment tasks passed with
clean compensation and stack shutdown before the shared stack was stopped.

## Browser recovery across reconnects after main synchronization

Main `1120a6b8f` brought PR #1494's finite browser-terminal reconciliation.
Merging that owner with notification deduplication exposed another missing
ownership invariant. The selected conversation retained its notification IDs
and recovery lease across reconnects, but each new completion owner allocated
an empty browser-observation map. If its first authoritative snapshot still
omitted an already received browser start and the chat answer was complete, it
stopped recovery. A duplicate start could not recreate demand because its ID
had already been claimed. A missed terminal update then left one active panel.

The real-hook/MSW replay failed on merged head `9efd7bb7b`: the cold reconnect
read occurred, the existing 150-second lease was still live, but five seconds
later there was no additional read and the browser panel remained active.
The unchanged replay passes when browser observations share the selected-agent
scope with notification claims. A fresh completion owner receives that same
map; selection changes reset both. The lease expiry and single-reader lifecycle
are unchanged, and duplicate notifications remain free of side effects.
The permanent test is `hooks-lib-browser-reconnect.blackbox.ts`, discovered by
ordinary frontend coverage. All twenty-two focused browser/backfill/delivery
checks pass. Pending old-source Group 3 lanes were explicitly cancelled and
joined before editing; those interrupted stages do not count as passing gates.

Archive searches were `reconnect browser FINISHED active panel backfill` and
`observedBrowserMessages stale snapshot lease duplicate INIT`. The July
cold-start reconciliation case is a relative, not proof of this boundary:
every subscribe already did a cold read here; the retained lifecycle demand
was missing after that read.

## Oversized reference-driven aggregate notifications

The completed load log contained a forty-seventh rejection, separate from the
forty-six small-message burst drops. Message
`f7555316-7d74-45d7-b46d-88cbf33afe5f` was a completed fifty-child for-each
aggregate, not the root's final-completion card. Its encoded payload was
455,542 bytes; admission counted 455,584 including the topic. Metadata occupied
455,258 bytes, including 452,911 bytes of `structured_response.items`.
The original unbounded sender attempted such payloads; actual broker acceptance
on that old path was not observed. The new finite queue rejected this record
before sending because it exceeded the 256 KiB per-agent admission budget.
The benchmark's durable API/tree evaluator did not observe this loss.

The deeper owned mismatch was the realtime representation: reference-driven
fan-out rows duplicated every child's output although the existing UI renders
`SubAgentTree` from `busId` and `subAgentIds` and hydrates node outputs through
its existing tree API/bus. Browser and Claude completion output are different
contracts and still need their structured metadata. Server model context and
API responses read the full persisted Message metadata.

A public-publisher fixture with fifty generic child outputs reproduced the
pre-send rejection (zero notifications versus one expected). The correction
projects only terminal TOOL for-each aggregate metadata with valid tree
references onto the existing realtime wire. It preserves message identity,
text, file pointer and every reference/status field, while omitting the
redundant child-output copy. Stored metadata is not mutated. No queue bound,
model context, channel, API query or recovery window is changed. Permanent
projection and preservation controls are in
`aggregate-message-broadcast.blackbox.ts`. The final byte-identical artifact
fails on `d7dce7b13` (zero frames versus one expected, 229 ms) and passes on the
corrected runtime (153 ms), through the same public blackbox command:

```bash
cd back-end
npx tsx src/tests/blackbox/run.ts aggregate-message-broadcast
```

The original ten-case delivery and six-case throughput artifacts remain
unchanged and pass again, as do format, affected lint and backend types. An
actual MessageBubble/SubAgentTree rendering replay confirms the child result
label comes from the existing authoritative child tree with aggregate output
absent from the wire. Archive searches were `structured_response broadcast
capacity` and `forEachAggregate duplicate child results`; their generic matches
did not establish a prior instance of this projection boundary. Fresh canonical
load and full final-tree verification remain required.

## Final corrected-runtime outcome before the next main synchronization

Runtime `c928ede47` passed the complete local gates: 196 backend blackbox
domains and 266 unit files, 157 frontend files with 2,735 passing tests and
three existing intentional skips, 110 agents blackbox domains, 184 fast-cache
checks and 134 units. Coverage was 89.55% backend lines, 83.29% frontend lines
and 82% agents. All 46 deploy structural gates passed; five cold seeds peaked
at 173 MiB under the unchanged 228 MiB bound. Live credential, Amplitude and
router-failover checks passed. The direct Linux controller lane passed its
16 scenarios, 21 wall-clock tests and 453 selected pytest cases.

Fresh Group 4 passed all eight smoke tasks, eight UI scenarios, the real E2B
sandbox check and four sandbox payment lifecycle tasks with verified owned
stack cleanup. Twenty unchanged latency samples passed: lifecycle p50/max
milliseconds were direct 886/932, web search 1,866/2,370, plan 635/793 and
execute 640/793. The shared semantic stack was stopped after every lane ended.

The fresh canonical fifty-agent load, root
`3970d936-93fc-4830-9458-275f9ee5bf39`, had zero owned admission rejections,
retry exhaustion, queue-age errors or oversized drops. Its 5,112 owned HTTP
spans all returned 202; the root peaked at 61 persisted writes per second
with batches up to fifteen messages. The completed aggregate retained the
same 455,542-byte stored payload while its projected notification was 2,608
bytes. The benchmark application's actual incoming INSERT recorded that
projected payload and all fifty child references. This proves subscriber
delivery; desktop rendering is covered separately and was not observed in
that load receipt. Terminal primary and load evidence was published with
fresh-browser and recording checks.

Main advanced to `9fcea8b67` with PR #1497's browser auth-context repair during
these gates. The passing results above belong to `c928ede47`; the synchronized
tree still requires its applicable gates and the final exact-head review and
production verification. The original Google session acceptance remains open.

## Synchronized auth-runtime verification

After merging main PR #1497, runtime `1c0b7a0da` passed the complete applicable
Group 3 again: 196 backend domains and 266 unit files (89.56% lines), 157 frontend
files and 2,735 passing tests with three existing intentional skips (83.33%
lines), and 110 agents domains, 184 fast-cache checks and 134 units (82%). All
46 structural gates and static checks passed. Five cold seeds peaked at the
reported 164 MB under the unchanged 228 MB budget. Controller checks passed
their 16 scenarios, 21 timing tests and 453 selected pytest cases. Live gates
passed with one explicitly warning-only Anthropic API-credit result.

Fresh Group 4 passed eight smoke tasks, eight UI scenarios, real E2B, and four
sandbox payment tasks with verified compensation and owned-stack cleanup.
Twenty latency samples passed; lifecycle p50/max milliseconds were direct
803/1,335, web 1,839/2,314, plan 638/643 and execute 792/1,725.

The fresh load root `9384357d-04b0-4758-bb12-dd300a5f9577` had 51 completed
agents and zero owned admission, exhaustion, age or oversize failures. Its HTTP
receipts included 5,279 successful 202s and two 502s followed by successful
same-topic, same-parent INSERT retries. The root peaked at 54 writes per second;
maximum queue delay was 127 ms. The actual subscriber received the 2,608-byte
projected aggregate with all fifty references matching the complete local tree.
The stored 455,542-byte payload retained its full output. Both primary and load
evidence passed fresh-browser publication and recording checks.

Main advanced again to `b12f0ef05` with admin-health and operational reporting
changes during these gates. These results belong to `1c0b7a0da`; the next
synchronized tree, final exact-head review and production verification remain
pending. Google server acceptance, the original restoration timeout's cause,
and the earlier saved-password choice remain separate open boundaries.

## Human feedback

Preserve the approved router and semantic deadlines. Fix the owning boundary;
do not turn selected conversations into indefinite polling loops or claim a
finite in-memory retry queue provides durable delivery.

## Reusable lesson

A failed acknowledgement does not prove a committed event was undelivered.
Keep retry ownership isolated, finite and observable, and make notification
consumers idempotent before retrying uncertain outcomes.


### October13 09:11 UTC — integrated operational gate failures

After main b12f0ef05 was merged as71b6d2718, the full Group3 boundary
08:31:43.737491–08:46:18.660559 UTC failed. Backend, frontend and agents
coverage, static checks and five cold seeds passed, but the controller and
deploy-structural lanes failed. The new benchmark-parent contract contaminated
`stability-proof --dry-sample` JSON stdout; synthetic campaign fixtures lacked
its required exact report asset; the old prose banner check rejected newly
approved fenced examples. These are separate verification regressions, not
additional proof of the historical notification symptom.

The exact registered fleet stability proof is unchanged: before JSONDecodeError,
after all27 tests and structural controls pass. Fixture completion preserves
task, clock, retry and cleanup assertions. The prose guard now checks outside
balanced canonical text fences. Additional report-route controls fail before
and pass after respecting value-taking options, so filenames such as `--help`
are not confused with help requests. The missing-contract fail-before-launch
negative control remains intact. Full post-fix gates, final review and production
verification remain required; this failed cohort is never recorded as a pass.


### October13 10:19 UTC — complete frozen-source release qualification

Frozen4b88ad7decb6f3ff31a8fba1b525c540ade0c683 passed all15 Group3
commands in the09:14:12.487275–09:48:57.677313 runtime boundary: backend196
domains/266unitfiles at89.56%lines80.98%branches92.60%functions with both
teardown paths; frontend157files/2735PASS plus3existing intentional skips
at83.33%lines; agents110domains/184fast-cache/134units at82%; lint,types,
frontend bundle,46structural gates,5cold seeds max161MB under228MB; controller
16scenarios,21clock tests and453pytest cases in250.83s. Credential health
6PASS/1Anthropic creditWARN/0FAIL, Amplitude and router failover passed firsttry.

Fresh Group4 passed8UI flows, realE2B, all8smoke tasks and4sandbox AgentCard
lifecycles with independent full cleanup. All20 retained latency samples and
4discarded warmups finished; lifecycle p50/max inms: direct783/820, web2309/3334,
plan633/1133, execute786/795. The timed latency stage includes waiting for
isolated benchmark cleanup; its09:52 start is not the measured-suite start.
Existing stdout/barrier source establish cleanup-before-measurement ordering,
while the exact measured-start timestamp was not separately captured.

The exact load root49fb8199-37e8-4f12-8159-7f551da23123/Hub8fbf200a
from stack1791885621-1465242-80941 had51COMPLETED agents captured before
cleanup, zero owned rejection/exhaustion/age/oversize receipts and5,127HTTP202
outcomes with no failed attempts or retries. Peak root writes64/sec, maximum
queue467ms. Actual aggregate39fb9ad6-3cb8-457f-9a3d-ef2828515c52 persisted
at10:04:33.672 with455542Bfullstored output; its2608Bwire frame was received
at10:04:33.849338 with all50unique child refs matching the complete tree and
no duplicated structured_response. This proves the benchmark subscriber, not
desktop rendering. UI and dedicated rendering replay remain separate proofs.

Canonical evidence publication for primary browser root80a2390d and load
root49fb8199 passed fresh-browser and recording guards. All sandbox cards are
CLOSED/zero/noattention; the abandonment4396cStripe refund and organization
reclaim succeeded. Exact owners/service births are absent and both cleanup
receipts clean. Shared semantic stack stopped by canonical worktree GC; its
foreground143 is deliberate teardown, not a failed test. All8017runtime source
hashes matched before this documentation/history stabilization. Fresh recorded
benchmark costs18cprimary/0cload/1cAgentCard bring the explicit14-run ledger
to122c. Final exact-head review, merge and all production gates remain pending.

### Integrated frontend typecheck follow-up (2026-10-13)

The Tamy continuation integrated main `6f5c4a9f9502dcd0a4a25cfe7cbffccc64edd1e5` by normal merge `0593671c6a0304ba5c14007ee17df2183aa3a64a`. Its full application typecheck found two errors in the existing INSERT-delivery regression: `makeDeps` exposed the mock as a React Dispatch, hiding `mockClear`, and the browser fixture helper widened the existing tool-status union to string. The same complete typecheck failed with two diagnostics before repair and passed in scratch afterward; all seven existing owning tests passed. Commit `44aef9823b6d8c875d81775a4ae911bde83e7be4` uses Vitest's existing `vi.mocked` identity helper and the existing exported `ToolStatus` annotation. Runtime fixture values, assertions and production behavior are unchanged. Fresh integrated frontend coverage and semantic verification remain required; these typing checks do not close the original production delivery gap.

An initial broader lint invocation also found an inline recording-player props annotation exceeding the existing function-size limit and a benchmark-Hub fixture using an erased `as any`. The repairs move identical props to an interface and annotate the unchanged fixtures with the existing `HubRunDetail` type. Both modified modules emit byte-identical normalized JavaScript; no fixtures, assertions, production values or protected P2 paths changed. Fresh full frontend lint has zero errors and nine existing warnings. Full application typecheck and coverage on `efcf6521c4e37e23dab02348269c9a87b512045a` pass: 160 files, 2,736 tests, three unchanged skips, all thresholds met, and all 18 captured process identities absent. The later call-formatting-only commit passes the full typecheck, targeted formatting and production bundle assertion. The initial failed lint and typecheck attempts remain in the timing ledger.
