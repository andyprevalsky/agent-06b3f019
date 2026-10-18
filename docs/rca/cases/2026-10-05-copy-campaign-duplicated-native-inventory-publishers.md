---
id: 2026-10-05-copy-campaign-duplicated-native-inventory-publishers
date: 2026-10-05
title: Repeated task campaigns duplicated the fleet native inventory publisher
surface: infra
component: benchmark-campaign-inventory
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-campaign created an independent app-wide native inventory publisher in each one-task fleet
symptoms:
  - fifty one-task controllers issue fifty Machines and Volumes inventory streams
  - native Machine list contains 19.9 MB of decoded JSON dominated by inline config files
  - first-child ownership cannot safely govern a feed borrowed by later campaign children
tags:
  - cloudbench
  - campaign
  - inventory
  - startup
  - ownership
sources:
  - PR #1299
  - commit 436844eb8c70e9e2fd15e1f6e33c01cedee75111
  - agent /root/demo_cache_integrity owning reproduction and independent review
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py
status: fixed
---

## Problem

The requested fifty-copy cached diagnostic uses fifty independent one-task fleet
controllers. The existing keyed inventory shared hot polling within each fleet,
but each campaign child still created its own app-wide native Machines/Volumes
publisher. One actual read-only native Machines query took 2.108 seconds and
returned 19,906,688 decoded JSON bytes; inline `config.files` accounted for
19,644,566 bytes, or 98.7%. These are decoded CLI bytes, not measured network wire
bytes: source files compress well. The observation locates duplicated API and
JSON work; it does not establish that this mechanism caused an earlier long cloud
stage or that removing it supplies a measured cloud E2E speedup.

## Diagnosis

Archive searches for shared inventory, inventory polling, Machines rate limits
and inline payloads found source snapshot ownership, compressed boot payload and
clone-source observation cases. They supplied ownership and generation leads;
none substitutes for a failing reproduction of campaign-wide publisher reuse.

The owning reproduction executes the real campaign scheduler and existing
inventory producer, keyed reader, refresh lock and cleanup at a controlled Fly
transport boundary. Two ordinary consumers perform four initial/first-loop
Machines reads; parent sharing performs two. With the actual captured native
payload, the ordinary path transported 79,626,752 decoded Machine bytes and the
shared path 39,813,376. That is a 50% two-consumer mechanism reduction. The short
controlled fixture was 0.797 seconds ordinary versus 1.564 seconds shared because
joining the parent auxiliary loop adds a one-second stop-watch wait. Neither
fixture timing is a cloud benchmark measurement or a network-byte saving claim.

The original-source controls fail publisher sharing, post-mutation refresh call
count and dead-publisher campaign ownership; the unchanged credential and
production-only inverses preserve existing CLI behavior. Fresh capacity admission,
primary-start accounting and exact post-mutation resource reads must remain
native. A snapshot generation cannot establish a mutation receipt or forgive a
resource that remains live.

## Solution

Extract the existing producer into one shell library used by both the fleet and
campaign publisher. The unchanged Fly credential resolver and PATH fallback are
shared as well. A multi-controller cloud campaign captures that small source
cohort privately and owns one auxiliary publisher until all waitable child
controllers have finished cleanup. All-production-only campaigns retain their
existing controller-local path and create no shared Fly feed. A standalone fleet
retains its existing publisher and cleanup behavior.

Borrowers verify the app, publisher token and exact initial process birth
identities, read the same atomic keyed generation, and never terminate the
publisher or unlink its FIFO. The existing live publisher/token/finite-expiry
checks and bounded native retry remain. Explicit generation refreshes still use
the original recoverable atomic lock and native producer; native capacity
admission and exact resource mutation/teardown checks are unchanged. Process death
fails closed rather than inventing a new PID behind a child's sealed attribution
or multiplying fallback RPCs.

If the shared publisher dies, write the existing cohort abort first, then issue
one TERM to the exact waitable controller roots. Their normal EXIT handlers own
resource cleanup, which the parent polls and joins. This path adds no short
KILL escalation or harness deadline. Publisher failure also reaches the final
failed campaign summary, including when first noticed while joining the feed.
Malformed section budgets are parsed before spawning a publisher. User-signal
cancellation retains its existing behavior; the shared feed is stopped only
after child processes are joined.

Five compact offline controls cover two consumers and borrower cleanup, a
paused-before-gate publisher-death case with terminal summary and cleanup,
post-mutation native refresh plus standalone ownership, existing credential
precedence, and the production-only inverse. The unchanged final selection is
**3 failed, 2 passed in 4.10 seconds** on original source and **5 passed in
8.47 seconds** with the fix. Existing source-contract controls
resolve the actual sourced library rather than assuming these functions remain
inline. The new file and existing snapshot copy owner are registered in the
compact deploy wrapper. Independent review approved the source and executed
16 focused controls in 20.72 seconds before the final paused-startup addition;
the final paused-startup owning selection is **5 passed in 8.47 seconds**,
and independent final review approved source and archive with **5 passed in
8.51 seconds**.

Private receipts are under `.context/acceptance/cli-preflight-prototype/`:
`native-inventory.safe.json`, `campaign-inventory-native-transport.safe.json`,
`campaign-inventory-function-equivalence.safe.json`, and owning red/green logs.
The actual token resolver, timeout, refresh lock, native generation refresh,
primary-start accounting, registry native reads, Machine reap and pool native
state functions are byte-equivalent to the original source. No raw provider JSON,
configured env, forensic captures or secrets are stored in this archive.

## Human feedback

Prioritize large measured startup stages, keep CLI improvements reusable by future
agents, preserve genuine benchmark outcomes and allow interruption at deployable
checkpoints. No task definitions, prompts, models, evaluators, harness execution
windows or cache identities change. This is a shared read-only infrastructure
optimization, not new mandatory benchmark rejection verification. The cached
performance experiment continues to earn zero LIVE acceptance credit, and actual
cloud width, terminal outcomes, resource closure and E2E timing remain unproved
until the separate live run supplies them.

## Reusable lesson

An O(1) provider feed inside each controller becomes O(number of controllers)
when a scheduler repeats the controllers. Share only bounded read-only
observations at the scheduler lifetime, while preserving exact owning mutation
checks and borrower cleanup fences. Count actual native calls and decoded work,
and report measured cloud E2E independently instead of converting transport
reduction into a fabricated speedup.


## October 15: compact consumers can still contend with their producer

A bounded native-free paired replay on the same retained 16-performance-CPU,
128-GiB controller used the original 28,903,796-byte Machines response, the
production 30-second wrapper, the real index publisher, and 600 compact readers.
Normal-priority readers produced a 21.160-second combined wrapper/publisher
completion. Lowering only reader children to niceness 10 produced 1.821 seconds;
wrapper EOF was separately observed at 0.574 seconds and publisher completion at
1.821 seconds. All 600 readers crossed the barrier and joined with status zero
in both cases. CPU PSI `some` cumulative deltas were 37,467,396 and 2,430,755
microseconds respectively. This single pair supports protecting the shared
producer; it does not prove the cause of historical native exit 142. The second
run completed fewer reader iterations because readers stopped when the producer
finished, so these numbers are not reader throughput measurements.

The explicit `CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE=10` option lowers only campaign
controller children at their existing Popen launch. Unset or `0` preserves the
original argv. Other values, missing `nice`, or a failed actual-priority probe
refuse before any selected child is admitted. The parent, shared publisher, and
external threshold watcher keep their existing priority. Local nested N2 and
controller helpers inherit the child priority. Provider-created VMs are separate
OS process trees: `run-bench-cloud` injects `bash /cloudbench-boot.sh` through
Machine config with an explicit environment mapping; this option does not send
an OS scheduling setting to that guest or change its task/evaluator definitions.
This source boundary is not a measurement of current guest niceness.

For bounded remote diagnostics, validate the actual response body rather than
CLI exit alone. A plain base64 supervisor payload was rejected as PayloadTooLarge
with CLI exit zero. Zlib level 9 plus base64 reduced the command to 12,085 bytes;
local round-trip SHA verification proved the exact reviewed supervisor bytes,
and the request completed the same atomic-mkdir once operation. Preserve the
rejected request and original clock, never reset or rename the once directory,
and distinguish transport/setup time from measured load time. The supervisor
joined all 604 owned Popen objects without signals. Do not use compression to
change source, bypass a refusal, or duplicate an indeterminate operation.

### Optional CLI finalizers consume the native read clock

Pinned flyctl v0.4.115 sends noninteractive CLI analytics synchronously after
command output. An offline paired control with the exact pinned binary and a
slow localhost metrics fixture emitted byte-identical version JSON and returned
zero in both cases: analytics enabled completed in 5.048 seconds; supported
`FLY_SEND_METRICS=0` completed in 0.046 seconds with no metrics request. This
isolates optional finalizer cost, not the cause of the historical nine exit-142
inventory reads. Ordinary cache-lock contention was separately bounded by the
CLI's one-second lock timeout and did not reproduce that outage.

Set the option only on the shared inventory Machines and Volumes read calls.
Keep the original native CLI, authentication, endpoint, JSON normalization,
EOF/status checks, freshness, and timeout. Do not export it for task processes or
interpret failed-command JSON as a successful inventory. Unavailable/invalid
clone-source observations must refuse distinctly from a positive unsafe-startup
classification; neither diagnostic authorizes allocation or a freshness waiver.

### Explicit fresh-workspace placement after a regional refusal

The e0f8 N2 preflight exhausted its existing clone attempts; both final provider
responses rejected volume creation with "no capacity available in ord" before
any task Machine launched. Feed recovery and successful Hub publication are
separate evidence. A timestamp-only N2 PASS from another region is not placement
proof: use an explicit source-and-region-owned stamp path and let the normal
preflight write it. N2 is a cheap negative/readiness screen, not a reservation or
proof of 600-task regional capacity.

`CLOUDBENCH_FRESH_TARGET_REGION` is an explicit fresh-only placement option.
Unset preserves donor-region placement. An opted-in fleet must use boot launch,
only real fresh-volume tasks, and no pool/private/snapshot/simulation source.
The verified donor region, mount, image, dependency fingerprints and snapshot
proof stay intact; destination clone and worker placement, child runtime state,
and provenance use the explicit target. There is no automatic region probing,
retry or timeout extension. Exact recovery ignores this placement-only option
and retains its existing recorded resource identities.

### Borrowed generation expiry after capacity admission

The first V31 failure logged successful capacity admission, then exited silently
before the next startup banner. Its claimed-pool file was created at
1792056946.564, after the retained prior generation's 1792056944 expiry and
before the next generation was published. The historical second-borrow status
and publisher liveness were not captured, so this is not a sole-cause claim.
An owning native-free control with real publisher/parent birth fences reproduced
an independent bug: expiry after admission made the redundant borrowed start
return 75, and the caller immediately converted it to silent exit 1.

Keep that transient pending only within the original capacity-admission deadline
and retry interval. Provision only after a fresh successful borrow; dead,
foreign, malformed or exhausted observations still refuse. Do not create a new
wait clock, renew inventory TTL, re-reserve capacity, fall back to native child
queries, or accept failed native JSON. This repairs the demonstrated caller
race; it does not establish the cause of the native Machines-list timeouts or
prove a successful simultaneous 600-task outcome.


### Explicit fresh-volume hardware placement (2026-10-15)

V32 selected task r001-j0048 failed fresh volume creation with `NO CAPACITY
AVAILABLE IN IAD`; the exact-parent threshold supervisor stopped the campaign.
The pinned flyctl v0.4.115 clone command defaults
`--volume-requires-unique-zone=true`, copying the donor mount name and 40 GiB
size. Fly documents that this excludes hosts already holding a same-name volume
for the app. The current topology showed 292 same-name IAD volumes across 255
reported zones. These are existing placements, not available capacity; neither
the topology nor the error proves anti-affinity was the sole historical cause.

`CLOUDBENCH_FRESH_VOLUME_UNIQUE_ZONE=false` explicitly opts eligible fresh
primary and worker clones out of hardware anti-affinity. Each task still gets a
new independent volume and VM, with the original size, guest, image, mount,
ownership, admission, retries and deadlines. Unset and explicit `true` retain
the original native argv. Only literal `true` and `false` are accepted; explicit
policy is recorded in execution provenance. Snapshot, simulation, private,
pooled and legacy boot allocation modes refuse this option before allocation;
exact recovery ignores allocation-only admission. No shared filesystem or
volume reuse is introduced. Keep IAD constant to test this placement hypothesis.

Actual clone-function controls on unchanged source failed the primary and worker
flag assertions (2 failed, 13 passed); the finite candidate then passed 37 owning
controls including provenance and recovery. This is a source-level repair of an
unneeded placement restriction, not proof of regional capacity or a successful
600-task run. Normal two-node preflight is a cheap negative/readiness screen;
only the unchanged full 600 simultaneous campaign can establish the goal.

Pinned implementation: https://raw.githubusercontent.com/superfly/flyctl/v0.4.115/internal/command/machine/clone.go
Provider semantics: https://community.fly.io/t/fresh-produce-app-wide-volume-unique-zone-handling/24000

### Borrowed inventory before provisioning (2026-10-15, V33)

V33's first selected physical failure was r001-j0160, whose last fatal message
was the post-stale-recovery capacity observation guard. The same message can
come from a failed forced refresh or from a compact inventory getter. The
historical branch/status remains unknown; this is not a new volume-capacity or
placement failure. The original supervisor's single exact-parent TERM followed
its first 1/1 terminal infra observation in about 0.173 seconds.

An actual owner/birth/token/health fixture reproduced the getter bug on unchanged
68e: recoverable borrowed status 75 exited before capacity admission, and
permanent pending lacked the admission exhaustion diagnostic (2 failed, 4 passed).
The finite caller audit also found this status lost at initial warm-source borrow,
its two compact getters, and conditional pool observation. These reads now use
one campaign-only pending helper. Its first actual typed pending response (or
normal admission, if no earlier pending) establishes the existing capacity
admission deadline. Parent-shell capture preserves that deadline across JSON
getters and admission without reset. Healthy observations do not spend the wait
budget during unrelated normal setup. Only an owned borrowed publisher's typed 75 waits at the
existing interval. Success still requires a current healthy observation; invalid,
dead or foreign authority refuses. Standalone reads pass through unchanged.
No stale JSON, additional native query, TTL, reservation or retry budget is added.

Forced post-mutation refresh remains mandatory. Its existing helper collapses
several failure classes into status 1; this patch does not pretend that all such
failures are pending. Actual-library controls retain failed-refresh refusal and
prove successful changed-generation refresh before admission. The historical
status-1 branch therefore remains an explicit limitation, not a claimed cure.
Warm-source and post-recovery controls additionally cover recovery, exhaustion,
already-expired original deadline, foreign/dead authority, and exactly one
reservation only after fresh observation. Full simultaneous 600 execution and
strictly below 5% infra still require an actual successful campaign.


The initial a7 candidate started its clock on a healthy borrow and was withdrawn
before invocation. An owning counterexample advanced Bash SECONDS by 301 during
normal healthy work; its first pending response incorrectly exhausted a budget
that had never waited. The successor moves clock creation to first actual 75,
with parent-shell JSON capture. A second owning control crosses two getters and
normal admission, verifies the same deadline, then proves an expired pending read
cannot obtain a new budget. No slow workload or provider call was needed.

### Cleanup admission and retired atomic-replace dentries (2026-10-15, V34)

V34 first failed at cleanup reserve admission, before provider mutation:
`unsafe cleanup admission file`. A single source/boot/epoch/terminal-bound
metadata read found the five retained candidate operands regular, UID 1001,
and single-link. No bad retained file was found; the historical exact path and
predicate therefore remain unknown. No ownership, file-type or hard-link guard
was waived, and no second guest read was made.

The actual campaign atomic JSON writer and native Linux `Path.lstat` reproduced
612 link-count-zero results among 193,949 reads in three seconds. A concurrent
`os.replace` can unlink the lookup's old dentry before its stat attributes are
returned, even though the current pathname is valid. An independent kernel
control observed the same class. The old one-shot predicate falsely refused
this legitimate producer transition. This establishes a causal bug class, not
which historical V34 operand triggered it.

Only an initial same-UID regular inode with zero links now triggers finite
re-resolution of the exact pathname. Each fresh descriptor uses `O_NOFOLLOW`;
`fstat` must show a regular same-UID single-link inode before acceptance. A
retired zero-link descriptor is never accepted. Symlinks, foreign UID and hard
links (two or more) still refuse. Thirty-two immediate descriptor attempts are
a fixed bound with no sleeps, new timer, native query, cleanup floor or reserve
policy change. Exhaustion remains a truthful refusal. Unsafe errors now include
the source-owned path and predicate attributes, without file contents.

A second pathname lookup after descriptor validation was deliberately removed:
it reintroduced the same atomic replacement race (the intermediate controls
and finite exhaustion evidence are retained). The final real-writer/guard
control returned 181,584 validated reads over 2,726 replacements with zero
accepted retired inodes and zero exceptions in three seconds. Deterministic
owning controls cover retired lookup followed by current descriptor, replacement
during open, persistent retired-descriptor exhaustion, and unchanged symlink,
foreign-owner and hard-link refusals. Full reserve budget, owner and nested
canary controls remain mandatory; no 600-task success is claimed by this fix.

### V36: complete Machines JSON did not establish native completion

The first selected failure was `r002-j0247` (`message-person-agent-sms`): clone
`817622b9500918` had a successful native allocation, but its existing 600-second
storage observation budget expired with status 75. The retained generation had
expired 11 seconds before the diagnostic and lacked the new clone key. This
proves unavailable observation, not failed or unmountable provider storage.
The last retained failed Machines read contained 58,493,720 bytes of complete
JSON (800 records) while its native wrapper returned 142. All 27 retained
completion warnings had an unknown foreground return marker. The exact native
post-render delay remains unknown; complete JSON never grants success to a
failed CLI call.

Only the campaign parent publisher's full Machines read now uses a bounded
HTTP GET. It retains the selected Fly session refresh, macaroon preference,
`FLY_FLAPS_BASE_URL`, full configuration, case-sensitive compat-check filtering,
and the original absolute read deadline. Non-200, redirect, incomplete, oversized,
malformed or late responses cannot renew inventory. Volumes, native mutations,
recovery, child readers, publication fences and TTL remain unchanged. The new
helper is copied into the publisher's immutable script scope and must be bound
separately from the existing native recipe inputs.

Owning offline controls exercise the actual full refresh and atomic index,
including stale ownership, slow bodies and cancellation during credential
refresh. A pinned CLI fixture proves equivalence of actual keyed and admission
consumer fields, while acknowledging unrelated Go default-field differences.
An old-path control produces complete JSON followed by a foreground delay and
correctly refuses publication; the full HTTP path publishes only after complete
200/EOF validation under the same fixture deadline. This removes the CLI's
unneeded completion dependency, but does not prove production latency or fix
all causes of provider unavailability. Validate the changed path once under the
existing bounded reader fixture before another paid campaign. Run the normal
N2 preflight before all 600 controllers under the same original overall budget;
do not use a near-expiry PASS cache to defer that work into controller startup.

### V38 clone-source typed availability boundary

The original first failing controller (`r002-j0237`, run `20261015-151720-14937`) refused allocation with source observation status 1, before any Machine was created. The getter collapsed `inventory_index_healthy` status 75 into 1. An actual same-process PID/birth/token-fenced, expired-health fixture reproduces this translation; the historical underlying status remains unknown. Foreign ownership and a missing keyed field remain fatal.

Preserve typed 75 and allow only a campaign-borrowed, owned-publisher pending source observation to wait. Arm its clock on the first actual pending observation and charge all waiting to the first existing 240-second native clone allowance. Pass only its remaining seconds to that first clone; healthy reads keep the original 240-second argument, and later attempts, storage waits, TTL and campaign deadlines remain unchanged. Expiry refuses allocation. This repairs the demonstrated status contract; it does not repair or explain the separately observed publisher availability loss, and is not a basis for another paid slice alone.

### V38 full Machines transport compression parity

An actual pinned v0.4.115 CLI request to the isolated loopback fixture advertises `Accept-Encoding: gzip` and decodes the gzip response. The initial full-HTTP helper instead advertised `identity`. A source-owned full-refresh control serving the same 1 MiB full configuration in 16 KiB chunks at 40 ms intervals exhausted the original one-second fixture deadline through the identity path; enabling gzip completes that same transaction and publishes the ordinary atomic index. This establishes a transport parity and bounded transfer improvement, not historical proof that the provider honored gzip or that compression alone caused V38 failures.

The helper now requests gzip, verifies wire HTTP 200/Content-Length/EOF, and independently caps wire and decompressed data at 256 MiB. Bounded zlib decoding requires a complete CRC-verified gzip stream with no unconsumed or trailing bytes. Identity responses remain supported; unsupported encodings, corrupt/truncated/trailing gzip, oversized wire or decoded bodies remain refusals. Decompression and full JSON validation stay inside the original request deadline; full configuration/private originals and all existing consumer and publication semantics are preserved. No summary response, field dropping, native fallback, TTL change or new deadline is introduced.

### V39: preserve the failed read boundary; freshness RCA remains open

The original V39 first physical failure was `r001-j0050`, task
`polar-odysseys-b421f308e18f`, run `20261015-163219-17942`. Clone
`8e37e1f7394968` exhausted its unchanged 600-second storage-observation budget
with status 75. The retained publisher history has thirteen Machines-list 142
cycles after its last completed refresh. This proves unavailable observation,
not failed provider storage. The strict first 1/1 infrastructure threshold and
its original exact-parent TERM remain authoritative.

The helper reduced every refusal to its exception class. The retained 40-byte
`Refusal` output therefore cannot distinguish authentication, response headers,
body transfer, decompression, parsing, validation or encoding. Four registered
controls exercising the actual publisher (held headers, held body, corrupt gzip
and successful full output) failed on the original source because the phase was
absent. The identical controls pass after preserving an allowlisted, private,
source-hashed phase sidecar alongside the existing failure diagnostics. Sidecar
creation is exclusive, no-follow, same-user/private-parent and limited to 8 KiB.
Only fixed phase, refusal, signal and exception-class enums, numeric timing and
byte counts are recorded; generic exception text, credentials, URLs, headers and
configured data are excluded. An unsafe or missing sidecar never changes native
status, output, deadline, ownership, publication or freshness. `complete` means
buffered stdout write returned; separate wrapper EOF/status and atomic index
publication still decide success. Missing or truncated evidence remains unknown.

The original freshness cause remains open. The actual campaign admission reader
already consumes the compact generation without inline files or environment;
an owning control succeeds with the full-snapshot path deliberately unreadable.
A real 600-registry scan does incur 8,400 external metadata programs, but neither
an eight-worker pair nor a 300-worker/8-CPU native-free replay reproduced the
publisher timeout: the full helper completed within its original 30 seconds.
These negative results do not justify a speculative metadata optimization as the
cure. The successful instrumented one-GET diagnostic under 600 compact readers
also does not reproduce actual concurrent clone/config traffic. Preserve this
distinction in the next unchanged original experiment; this evidence repair is
not a successful 600-task outcome or a freshness cure.

### V40: session autogroups defeat the selected-controller priority opt-in

V40 first failed on `r001-j0047` (`message-person-agent-sms`, run
`20261015-185403-16666`): clone `d8d0760a367d08` exhausted the original
600-second storage-observation budget with status 75. The retained prior
generation expired at epoch 1792091495; the next generation was published at
1792091618, after the first physical failure at 1792091580.350877. Its unchanged
publisher token and this gap corroborate unavailable inventory. The exact
historical keyed clone observation remains unknown. The final failed helper
sidecar shows an alarm during JSON encoding, with 30.57 seconds wall time but
only 1.71 seconds of helper CPU. This is not proof of failed provider storage.

A source/birth-bound observation found the publisher at process nice 0 in
autogroup 6 and a selected nice10 controller in autogroup 8, both in the root
CPU cgroup with Linux autogroup scheduling enabled. Creating a new session for
every controller creates a separate equal-weight autogroup; process nice10
then does not give the publisher its intended priority across those groups.
The earlier negative CPU replays shared a session and therefore missed the
actual scheduling topology.

One bounded native-free pair on the closed original controller used the exact
helper and wrapper, a full 69.51 MB synthetic configuration response, the
unchanged 30-second deadline and 32 positive-CPU nice10 workers on one CPU.
Separate worker sessions reproduced status 142 after 34.15 seconds, with TERM
during encoding. Changing only workers to inherit the broker session while
retaining individual process groups completed the identical full output with
status 0 in 2.79 seconds. Every worker was alive at request start and wrapper
completion, every worker and native group joined, and the server thread joined.
No provider query, kernel setting, TTL change or artificial helper delay was
used. This establishes the scheduling failure class, not an original 600-task
success or an explanation for every historical timeout.

Only explicit `CLOUDBENCH_CAMPAIGN_CONTROLLER_NICE=10` selected launches now
inherit the parent session and create a unique process group. Default/unset/0
still create a new session. Missing Python `process_group` support refuses
before campaign resources or controllers are admitted. Publisher, Hub, seed and
nested-runner session lifetimes are unchanged. Registered real-launch controls
verify nice, SID, PGID, autogroup, PID/birth and default/refusal behavior. A real
`terminate_owned_children` control drains one controller and its grandchild
without affecting the shared-session parent, sibling controller or publisher,
then verifies normal cleanup of the remaining owned groups. The unchanged
original 600-task outcome remains required before closing the freshness RCA.

### V41: exceptional borrowed refresh can block the parent publisher

**Original 600-task outcome: FAILED; RCA remains OPEN pending the unchanged
experiment and independent provider-capacity resolution.** The first physical
attempt `r001-j0077` on source `82b849eee20f9527426beb4f540d02553d83dc80`
reported “timed out waiting for the serialized inventory refresh,” followed by
an unresolved clone name. Its original log SHA-256 is
`f3beb20dcf8230639638cbd31f580afda10ed0d357d864f4628ce58fdee2679b`.
The last of five clone attempts separately reported the provider organization
Machine limit. Earlier native clone bodies and the historical refresh-lock
owner were not captured in that job log. Neither the shared history nor the
last parent HTTP phase identifies the caller of each failed native read.

Source tracing found an intentional exception to ordinary read-only borrowing:
`refresh_machines_snapshot_after` allowed a borrowed post-mutation resolver to
acquire the parent publication lock and run the borrower's native `FLY` commands.
The parent uses its full-HTTP Machines transport; the borrower uses native CLI.
Both write the same refresh history. Thus a healthy parent transport can still
be excluded by a borrower whose native command does not finish. The original
October 5 policy explicitly allowed this exception; the new policy changes it
rather than claiming the old implementation violated its documented contract.

The registered two-consumer reproduction runs the actual campaign scheduler,
producer, birth/token checks, lock, atomic index and cleanup against controlled
transport executables. The borrower emits complete Machine JSON and then delays
native completion, while the parent transport remains healthy. Test-only native wrapper,
parent lock-wait, borrower observation and poll bounds are 6, 4, 6 and 1 seconds
respectively. These discriminate
lock ownership without changing production 30-second reads, 95-second refresh
waits, 20-second clone-name lookup or any benchmark budget. Original source fails
the permanent regression with the same serialized-refresh error. This proves a
causal class, not the historical V41 command delay or lock-owner identity.
A prior negative fixture, in which the parent won the next-generation race,
is retained separately and is not counted as a failing reproduction.

Borrowed exceptional refresh now waits for the same birth/token-fenced parent
to publish a different healthy generation. It never takes the publication lock
or calls native `FLY`. Identity is read before and after the real health check;
a pointer transition cannot credit an unchecked generation. Empty, missing,
same-generation, stale or failed output never grants success. The wait uses the
existing refresh bound and, for clone-name resolution, the minimum of that bound
and the caller's original absolute lookup deadline. Fatal owner/token failures
refuse immediately. Standalone explicit refresh retains its original native
producer, recoverable atomic lock and coalescing behavior. The post-recovery
capacity consumer still requires a fresh generation before its compact read.

Owning coverage is registered in
`agents/benchmarks/cloudbench_campaign_inventory_test.py`, including real native
birth/token failures, stale generation recovery, changed-generation races,
owner transitions and caller-deadline propagation. Existing standalone lock,
coalescing and late-publisher controls remain in
`agents/benchmarks/cloudbench_dependency_sync_test.py`. The old test fixture now
supplies the parent's controlled HTTP executable and actual capture dependencies;
missing fixture dependencies are not classified as production feed failures.
No provider request, current guest edit, task/profile change, stale-data waiver,
TTL extension or paid retry is part of this repair. The final permanent test fails against the original Git-bound runtime in
9.82 seconds with the exact serialized-refresh error. The identical final
selection passes 28 controls in 15.46 seconds on the repair; three existing
standalone lock controls pass in 2.66 seconds. Earlier fixture timing and missing
dependency failures remain recorded separately. Same-test GREEN is a mechanism
result; only the unchanged original 600-task experiment can establish its outcome.

## October 15 standalone fixture synchronization follow-up

The concise kickoff notification deployment merged current main and reproduced
an offline fixture race in the existing ownership control. The full deploy
structural run reported `assert 3 == 4` in
`test_campaign_inventory_post_mutation_refresh_keeps_native_generation_and_ordinary_fleet_ownership`.
Its original receipt is
`.context/deploy-runs/20261015-023030-48107/logs/deploy-command-structural-20261015-174429-753568.log`:
623 selected controls passed and this control failed. Archive searches for
`inventory ordinary fleet owner first asynchronous poll fixture` located this
owning case; its existing solution and human feedback remain applicable.

The standalone fixture ended its first controller immediately after startup.
Startup joins the initial native read, while the first periodic refresh runs
asynchronously. The controller's correct EXIT cleanup could therefore cancel
that refresh before the fixture's four-read assertion observed it. This is a
test-fixture/environment mismatch, not evidence that ordinary fleet cleanup or
campaign sharing should change.

A controlled 100 ms native-read delay reproduced the unchanged failure before
the repair: one parameter passed and one failed in 5.03 seconds. The fixture now
records the owning job on each native read and waits for that owner's second
machine read and refresh-lock release before exiting. The exact four-read
assertion remains. Both delay parameters then passed in 5.45 seconds, and six
focused ownership controls passed in 10.87 seconds. No production publisher,
provider call policy, timeout, task prompt, assertion, or cleanup rule changed.
The full deployment structural suite is rerun separately and remains the
required integration gate.

No new human feedback was recorded. Join the asynchronous observation a fixture
asserts before invoking that fixture's normal owner cleanup.
