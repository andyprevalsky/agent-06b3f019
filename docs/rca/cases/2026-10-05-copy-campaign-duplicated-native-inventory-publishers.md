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
