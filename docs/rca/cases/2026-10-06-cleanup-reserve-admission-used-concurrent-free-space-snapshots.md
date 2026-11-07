---
id: 2026-10-06-cleanup-reserve-admission-used-concurrent-free-space-snapshots
date: 2026-10-06
title: Concurrent fleet controllers consumed disk capacity from independent snapshots
surface: infra
component: cloudbench-fleet-cleanup-reserve
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: reserve_cleanup_disk_space read free space independently before concurrent physical allocations
symptoms:
  - fifty-copy cached campaign failed during preflight before any task allocation
  - twenty-eight controllers reported cleanup reserve refusal
  - native controller filesystem reached its capacity limit
tags:
  - cloudbench
  - disk-reserve
  - cohort-admission
  - concurrency
  - process-identity
sources:
  - PR #1422 follow-up
  - fleet run 20261006-180139-2969
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_cleanup_releases_emergency_disk_reserve_for_cohort_budget
status: mitigated
---

## Problem

The supported CLI launched fifty controllers for the existing cached mass task.
All fifty finished without a task allocation, execution or evaluation. The
campaign took 782.915 seconds through controller exit and receives zero proof
credit. Native observations showed the controller filesystem reaching its
capacity limit, with about 3.42 GiB free at the earlier observation. Twenty-eight
controller logs reported reserve refusal. Two infrastructure canaries were
allocated and required exact-owner recovery; they were separate from the fifty
task copies.

Original logs and native ownership captures remain private under
`.context/fresh-basic-claude-final50-20261006/`. The original allocator suppressed
its low-level stderr. Consequently, the precise first failing live controller's
allocation-error versus post-allocation-floor branch remains unproven. This
case does not claim that local evidence alone resolves the live fifty-copy
failure or proves its startup performance.

## Diagnosis

Archive searches used the literal reserve refusal, concurrent cleanup reserve
headroom and physical allocation. The
[temporary-filesystem case](2026-09-27-cloud-controller-temp-root-ignored-persistent-volume.md)
concerns a launcher's choice of filesystem; the
[zero-fill case](2026-09-27-fleet-cleanup-reserve-zero-fill-delayed-readiness.md)
concerns unnecessary writeback. Neither owns this admission race.

Each controller independently observed free space and preferred a 512 MiB
reserve. Fifty callers could therefore request 25 GiB from overlapping free
space snapshots. No transaction reserved the pending cohort's 32 MiB per-copy
cleanup minimum and 256 MiB per-copy working headroom before allocation.

An unchanged owning-boundary driver ran fifty real reserve functions against a
bounded storage transport. The original source admitted 32 and failed 18;
the candidate admitted all fifty while preserving every cleanup and working
floor. The transport held admitted owners alive through all admissions and
performed no provider or task calls. It models capacity accounting, rather
than proving fifty native physical allocations. A separate real macOS control
verifies native physical allocation and release.

Independent review also reproduced two owner-identity defects in an intermediate
draft: timezone-dependent process birth strings could lose a live owner's
headroom, and a changed birth for the same PID could be adopted during
allocation. The unchanged interleavings passed after pinning the `ps` child to
UTC and requiring the final birth to equal the initial birth. The reviewer
independently reproduced the PID-reuse rejection and neighboring-file
preservation.

## Solution

Admission now holds one user/filesystem lock across a fresh free-space read,
sealed cohort validation, fair sizing, physical allocation, synchronization and
post-allocation floor checks. Pending sealed cohort members retain both minimum
cleanup capacity and working headroom. Live admitted owners retain their working
floor until their exact process birth retires. Standalone calls use the same
atomic transaction without reserving capacity for unknown future callers.

Accounting hints are bounded, validated and separate from provider ownership.
They never release a Machine, volume or ownership claim. Failed allocation
removes only the reserve whose captured inode/device still matches. The storage
defaults, workload, task grading, model calls and production timeouts are
unchanged. The native macOS allocation recurrence is documented in the existing
zero-fill case.

The permanent owning controls are selected by
`scripts/tests/benchmark-live-results.test.py`, already part of the normal
deploy process. They cover fifty-owner admission, timezone and PID-reuse
interleavings, allocation capability/error boundaries, physical reserve shape,
exact cleanup order and preservation of unrelated files. Fixture observation
guards allow sixty seconds without changing outcome assertions or runtime
limits. Combined runtime source SHA256 at independent review was
`219ac91bdcc0497834d0e2fda37f4717cdf42b142ad1984b428fd55f8feae3c4`.

The code-level admission repair has causal proof and independent review.
Successful fresh fifty-copy execution and full native release remain the
outcome gate, so this case is mitigated rather than a completed fleet proof.

## Human feedback

The user required parallel optimization work, a five-minute cached execution
window, truthful stage timings, unchanged benchmark behavior and exact resource
release. Quick regression tests must run in the ordinary deploy process; large
performance diagnostics require an explicit request. The user rejected overly
aggressive observation assertions and requested realistic breathing room.

## Reusable lesson

Admit a sealed concurrent cohort against fresh disk capacity in one transaction before allocating its physical cleanup reserves.


## Review recurrence: retired unadmitted members

The final review identified a separate admission-floor recurrence. A cohort's
parent can remain alive after a child retires before allocating its reserve.
The immutable custody manifest correctly retains that child, but the admission
loop counted every unconsumed member as pending. Its cleanup minimum and working
floor could then deny capacity to a surviving controller.

Two archive searches covered pending cohort members, native process births,
abandoned reservations and cleanup headroom. This case owns the allocator;
the pre-release-member failure case owns survivor scheduling. Custody membership
must remain unchanged in both.

An actual owning control invokes the real shell reserve function under a held
native parent lock. A waited/reaped child supplies the retired manifest PID.
The fixture isolates its accounting namespace and bounds the free-space
transport while preserving real process-birth observations and real 1 MiB native
physical allocation. Original 5c1fc870 fails the retired-member case and passes
both live-member and unassigned-member inverses (1 failed, 2 passed, 0.93 s).
The unchanged three cases pass against the repair (3 passed, 4.65 s). Initial
scratch setup errors from a missing adjacent library were retained separately
and are not causal reproduction credit. No provider or model calls occurred.

The accounting loop now rereads bounded, owned cohort membership and removes
only assigned, unconsumed members whose native process birth is absent from the
fresh snapshot. Unassigned members remain eligible to launch. Any live or
uncertain PID, including a possible reused PID, conservatively retains its
floor. Consumed owners retain the existing exact-birth accounting. No custody
manifest, provider resource, production budget, benchmark result or reservation
default changes. The new three-case control joins the existing
`cleanup_releases_emergency_disk` deploy selection; no separate gate is added.

This is owning-boundary evidence, not a claim that a fresh fifty-task fleet has
finished or that its live startup problem is resolved. The independent DAILY-50
control continues on its frozen pre-repair source without interference. Private
source, unchanged controls, native test results and independent-review receipts
are retained under `.context/fresh-basic-claude-final50-20261006/deploy/`.


## October 6 deployment-fixture recurrence

The normal structural gate on immutable `85070617776b8355565266bf16f08a58093c1072`
failed six existing fixture targets on a host observed at load 107 with 14 CPUs.
The fifty-owner reserve driver exceeded its outer 90-second observation guard.
That outer subprocess timeout killed the Python driver while 46 original Bash
owners remained alive, waiting for a retire marker in a subsequently deleted
pytest directory. The driver lacked cancellation cleanup, and its accounting
fixture shared the real filesystem admission namespace. Live fixture floors
could therefore interfere with later tiny reserve controls. This is a fixture
failure; it does not prove a new production admission defect.

The original deployment owner revalidated the exact source, fixture path, job,
native birth and command of every original owner before individual TERM signals.
All 46 original parents were positively absent and their original group was
empty afterward. No foreign namespace or Freedom resource changed. The shared
admission ledger was preserved; the later read-only classification contained
no exact-original fixture group. The unchanged ten-case capacity-loop control
then passed in 16.261 seconds with every recorded owner absent and child reaped.
That observation supports host interference, rather than a capacity-algorithm
repair or an accepted fleet speedup.

The fixture now uses a unique accounting namespace through its existing local
filesystem transport. It still runs all fifty default owners against the same
18,000 MiB modeled capacity, native process observations and original storage
floors. FIFO handoffs replace fork-heavy start/retire polling. On interruption,
the driver closes launch admission and drains its recorded private child
sessions only after matching native birth, fixture path and PGID. Reaped or
recycled leaders cannot authorize signaling. The existing owning test adds a
cancellation-before-admission handoff and requires all fifty children reaped;
the ordinary admission case retains every original outcome assertion.

The affected offline fixtures share a 600-second host observation guard.
Production task, provider, autoscaler-finalization and cleanup budgets are
unchanged. Final focused verification passed sixteen cases in 48.904 seconds,
including timezone/PID-reuse, capacity, ordinary inventory, repeated-cache
controls and the existing strict-barrier inverses. Both cohort handoffs created and reaped fifty children. The actual
permanent compact selector collected all eight cases without selector changes
or an unrelated catalog-count assertion. Initial private dependency and helper
module-layout setup failures receive zero final proof credit.

Private source, original failure, final native proofs and registration receipts
are in `.context/fresh-basic-claude-final50-20261006/deploy/root-structural-fixture-repair/`.
Full normal deployment composition and independent review remain separate gates.
No provider/model calls, benchmark results, acceptance credit or production
performance claim arise from these fixture controls. This case remains mitigated.


## Remaining synthetic-capacity fixture isolation

The next normal affected gate on `5e4e5458` passed 306 controls and skipped
four existing platform cases, but its older single-controller allocation
fixture still combined synthetic `df` values with the host-wide real admission
ledger. Its 4 MiB capacity subcase was correctly denied by live neighboring
controller floors before it could observe the expected 2 MiB scaling message.
The earlier fixture repair isolated the fifty-owner and stable-birth fixtures;
it missed this older physical-allocation and storage-error control. This is
fixture contract maintenance, not a new runtime admission defect.

Both archive searches (`insufficient physical cleanup floors pending controllers
synthetic df` and `cleanup reserve fixture namespace concurrent fleet mocked
free space`) lead to this owning case. The zero-fill and temporary-filesystem
cases are relatives. A source-bound reduction preserves the exact existing
control and all fifteen assertions. It holds one real 1 MiB sibling reserve
in a private accounting namespace, with a live native shell owner throughout
the control. Original source fails the same scaling assertion; the repaired
fixture passes all allocation, low-space, post-allocation-race, physical-byte
and storage-failure subcases. The final formatted causal pair takes 0.546
and 1.756 seconds respectively. The native sibling reserve remains intact until
the fixture completes; every recorded native owner and process group is absent
after its normal handoff. No live fleet admission ledger is modified by this
reduction, and no provider or model call occurs.

The fixture now assigns its exact temporary parent a private device namespace
through the existing local `Path.lstat` transport. It propagates that same
namespace into each allocator-fault subprocess, preserving real process births,
physical allocation, unchanged capacity values, and all capability/error
assertions. Production files, budgets and cleanup floors are unchanged. The
existing permanent `cleanup_releases_emergency_disk` deploy selection already
owns this control. The original full-gate failure and initial private import
setup failure remain recorded separately; neither is converted into a passing
receipt. Final normal affected qualification remains mandatory.


## October 16 local fetch-capacity refusal (related operational boundary)

At unchanged source `db99e0f616848a0a65fe5aedc3a62264158c9af2`, the normal
agents coverage command ran all 110 blackbox domains and returned 109 passes
and one benchmark failure. Six authenticated boot-payload fetch controls were
refused by the real `cloudbench-fetch-ref.sh` free-space guard: required
2,097,152 KiB, observed approximately 1,796,220 down to 1,618,060 KiB. This is
a correct admission refusal, not evidence that the concurrent reserve race
above recurred or that the guard should be weakened.

The root coordinator reported removing only duplicate tracked history working
copies in two positively retired worktrees after matching their retained Git
objects and checking for live cwd/file descriptors. Source, dirty patches,
evidence and Git history were retained. That operation reported reclaiming
4,671,488,593 bytes. The next attempt independently recorded 5,910,945,792
available bytes before launch. Freedom and other protected assets were not
part of this correction.

Both attempts used the same command, source, fixtures and assertions:

```bash
cd agents
source venv/bin/activate
bash ../scripts/run-deploy-stage agents-coverage-blackbox --reuse-passed -- \
  env AGENTS_COVERAGE_CONCURRENCY=6 bash scripts/run-coverage.sh
```

The unchanged benchmark domain passed in 210.59 seconds on the second attempt;
all 110 blackbox domains and 184 fast-cache tests passed. The complete command
still exited 1 because the later unit phase reported 132 passes and two pointer
activity fixture failures (`Not in activity context`). Those failures have a
separate boundary and repair owner. Neither original full command is relabeled
PASS, and no final qualification success is claimed here.

Private evidence is under
`.context/deploy-runs/reusable-pool-cutover-r2-20261016/`:
`A-FINAL-CAPACITY-FAILURE.json`, `A-CAPACITY-CORRECTED-ATTEMPT-START.json`,
and `A-FINAL-UNIT-CONTEXT-FAILURE.json`. Both normal stage logs and domain logs
remain retained. Known owned wrapper/pool/benchmark/unit PIDs retired normally.
No runtime, dependency, fixture, deadline, capacity threshold or policy changed
for this operational correction. Archive searches used the literal
`cloudbench-fetch-ref insufficient free space` and behavioral
`retired worktree duplicate history disk capacity`; the reserve-admission case
is related capacity context, not the diagnosed mechanism of this refusal.

No additional human feedback was recorded for this operational incident.


## November 4 PR1662: multi-workstream fake provider inherited the host disk ledger

Frozen8c63501f0afa0e3f4c5aafd3e29e01a119eb5f2a, round43 native
multi-workstream failed scenario1 for both ws-a and ws-b with
`cleanup reserve admission failed: [Errno 28] insufficient physical cleanup
floors for pending controllers`. Neither reached the expected measured
new-Machine refusal. The original result remains failed/UNVERIFIED; its
supervisor adopted children and recorded quiescence with every child reaped.

Two bounded archive searches used the exact insufficient-physical-floors
message/private disk ledger fixture and cleanup-reserve fixture/device ledger.
They lead to this owning case, including its earlier physical-allocation
fixture namespace repair. That correction held for its callers but missed the
multi-workstream fake provider. The latter pinned private TMPDIR for script
snapshots while production reserve accounting deliberately selected
`/tmp/rose-cloudbench-cleanup-admission-UID/<parent.st_dev>` and actual df.
It therefore consulted the same physical device ledger as unrelated host
controllers. The saved device65024 ledger has14 standalone groups with256MiB
headroom each, zero inflight entries, and a modification time before both
08:50 native fixture refusals. A later2879MiB free-space observation is not the
original atomic df result. No contamination by stress200 is inferred: its
storage transport already uses an independent virtual device.

The permanent existing volume-contract owner now exercises the actual
run_controller environment stanza and unchanged native reserve function using
one controlled foreign live reserve on a500MiB simulated host. On the original
launcher the identical command fails with the same native ENOSPC. The candidate
passes: all fake workstreams share one finite18000MiB private disk/ledger
namespace with sparse files, and the foreign native ledger bytes remain exact.
A deliberately insufficient200MiB private disk still triggers the original
native256MiB floor refusal. No guard is replaced by a successful stub. The
complete existing fake-volume-contract owner also passes, retaining every
original main statement/assertion and its malformed-provider-volume negatives.
This low-load control starts no provider, task, fleet or200-owner stress run.

The fixture-only repair supplies scoped lstat/fstat/posix_fallocate and df
transport at the fake-provider launcher. Allocation accounting subtracts live
private reserve bytes under a fixture-owned lock. Actual native allocator,
cohort/debit/floor, process-birth and identity checks remain unchanged. After
its own fixture processes are absent, cleanup retires only its exact synthetic
namespace. Production run-bench-fleet is byte-identical; no real host ledger,
physical cleanup reserve blocks, timeout, test assertion or concurrency changes.
Independent review of full patch
ecb08595703b3276e193e6b5cba8d1857077d7f59723f32a539364ef5a80c118 is CLEAR.

Exact commands, from the candidate source root, are:

```bash
python3 scripts/tests/cloudbench-fake-volume-contract.test.py --assert-private-cleanup-storage
python3 scripts/tests/cloudbench-fake-volume-contract.test.py
```

The first is the identical causal RED/GREEN invocation. The second is the
existing low-load owning command, invoked by the ordinary multi-workstream
fixture; default main now includes this regression. Private candidate root is
`/var/tmp/pr1662-8c635-controller-rca/candidate`; source preimages and full patch
bindings are in `multi-report.json` beside it. This is causal fixture proof,
not an unchanged full multi-workstream/controller PASS. Parent owns source
integration and the actual full validation.

Two separate original failures remain UNKNOWN: selected-pytest's live uncaptured
root test took11.711610210011713s against its8s elapsed assertion, and structural
stress200's sealed driver exceeded120s. The former's only surviving input is
child.pid; no helper/parse/startup/kill-wait phase timing or stdout/stderr was
captured. Its12s outer,5s helper,20s sleep and8s assertion stay unchanged.
The latter retains only an empty storage.lock after its timeout and directory
removal race; it has its separate open evidence-loss case. Neither unknown
failure is attributed to this disk fixture or relabeled by these passing
controls. All original outcomes, source bindings and cleanup obligations remain.


## November 4 PR1662: seed inventory fixture shared the host cleanup ledger

Round49 on `0af9bc091328f30cd505fea9c132ba48f7d9c7da` failed
`test_campaign_inventory_seed_preflight_failed_proof_publication_never_admits_controller`
at the expected single GET: the recorded call list was empty. The rescued
original summary records `cleanup_ticket_failure=prepare`, an aborted cohort,
zero admitted children and no seed-preflight output or prepared budget. Native
FAIL/UNVERIFIED and the original orphan/cleanup facts remain unchanged.

The fixture already reduced its own policy to1MiB preferred/minimum and zero
headroom, but still keyed native ticket admission by the real host device.
The host's separate legacy ledger contained14 groups and3758096384 bytes of
liability. Its immutable-state hash was `d91711e0...`; a later3146440704-byte
free-space observation was not the original round49 `df`. The original exact
prepare error/free-space input remains unavailable, so that historical capacity
cause stays UNKNOWN. No old ledger entry was removed or reclassified.

The unchanged owning function reproduced the same prepare/zero-GET assertion
failure in1.833s. Isolating only this fake workspace's directory device in its
native Python transport made the same function and assertions pass in2.694s:
one complete loopback GET ran, then the intentionally failed atomic proof
publication still returned native campaign exit1 with no admitted child. This
is fixture-boundary proof, not a campaign/task PASS or a production allocator
repair. The shared host ledger remained byte-identical in these observations.

The one-file candidate scopes `Path.lstat` and `Path.stat` directory identities
only below this fixture workspace, using an unpredictable invocation-specific
namespace. File identities, real native `df`, physical allocation,1/1/0 policy,
30-second subprocess ceiling and all101 existing test function ASTs are
unchanged. Native campaign, seed and cleanup-ticket helpers are byte-identical.
The earlier private-device fixes covered reserve/multi-workstream fixtures;
this separate seed fixture had not adopted that isolation.

A registered same-command control fails with only the isolation call absent
(2.957s), then passes restored (4.545s). It preserves a self-owned foreign
ledger byte-for-byte while the original GET/publication assertions pass. The
same finite debt inside the fixture's own private ledger still causes native
prepare refusal, zero GETs and zero admitted children. Its pressure derives
from real device capacity; neither `df` nor native floor checks are replaced.
It does not assert an unrelated live host ledger stays immutable while
legitimate sibling producers run.

Exact patch `1f609135...`, logs, source bindings and report `3ac28eaf...` are
retained under `/var/tmp/pr1662-49-seed-ledger-isolation`. No live provider,
production accounting cleanup, canonical state/source edit or full structural
sweep was performed by this reduction. The parent-owned combined-source full
gate is still required; prior round48 stop timing remains a separate UNKNOWN.

## November 7 Google400: ordinary full-width campaigns omitted pending owners

The ordinary 14-controller campaign `75588b14a9ecaa2a3efeb1caac10b589c1c79e3d1904977c21611f498acf3d87`
on source `3c1f4603563862c70cb5e3eb5adbd4e21288f2c3` failed before task execution.
Two jobs failed with `cleanup reserve admission failed: [Errno 28] insufficient
physical cleanup floors for pending controllers`; two cancelled siblings also
exited1 at the same floor guard or `cleanup reserve consumed controller operating
headroom`. Other siblings exited through owned cancellation. A prior observation
had7,758,327,808 free bytes. Fourteen preferred512MiB allocations plus256MiB
working headroom do not fit that disk, while all32MiB minimum reserves plus the
same working headroom do. These are unchanged policy values, not requested limits.

The first bad boundary is ordinary campaign dispatch. `run-bench-campaign.py`
prepared cleanup cohort tickets only when `strict_start` was enabled. This
ordinary campaign had no `startup-cohorts` or cold ticket grant; its controllers
registered as separate standalone groups. An early owner could consume its
preferred reserve before a later owner's minimum and operating headroom became
visible. The late failure is not evidence of cold-ticket double debit: this
campaign never created those tickets. Physical floor checks correctly refused
the overcommitted local disk.

The owning regression uses the real campaign dispatcher, extracted native fleet
reserve/release functions and existing cleanup-ticket helper against a finite
8000MiB storage transport. Fourteen concurrent real child processes preserve
512/32/256 policy, with ten allowed to admit before the last four register. The
original dispatcher fails with the same physical-floor ENOSPC. The candidate
passes all14, and a task-start event occurs before the final reserve attempt,
proving this repair adds no task barrier. Sparse fixture files and bounded
block-reporting transport model physical allocation without writing GiBs; this
is accounting proof, not a real cloud task result.

The scoped repair predeclares all known owner liabilities for ordinary schedules
whose total job count is at most their requested concurrency. It reuses the
existing strict-cohort budget preparation, owner assignment, claim, release and
retirement protocol under a separate `cleanup-cohorts` directory. The strict
startup canary, synchronization, scheduling loop, child argv and cleanup floors
are unchanged. Rolling ordinary schedules with more jobs than concurrent slots
retain their previous path and are explicitly outside this repair's claim.

The identical final regression fails on the original producer and passes on the
candidate. Eight campaign controls pass, including no-barrier ordering,
preparation failure with no task dispatch, assignment failure with joined child
and retired grant, and unchanged strict startup/failure controls. All11 existing
cleanup-ticket tests also pass, including nested-canary ancestry and the single
released nested slot. Original logs, exact patch hashes and commands are recorded
in `.context/rca-google400/ordinary-cleanup-candidate/handoff.json`.

The native75588 failed outcomes remain immutable. Supported normal preallocation
reconciliation retains14 sealed zero-resource audits and two retired custody
records with no acceptance credit. The original proof remains `still_bound`
before and after candidate validation; no validator exception or producer proof
rewrite was added. Fresh full-source gates and an actual14-task cloud smoke after
integration remain pending. This recurrence therefore preserves this case's
`mitigated` status and does not claim the deployment or Google/phone acceptance
has completed.

The user required keeping Freedom and all evidence, preserving concurrency and
cleanup floors, and avoiding limit changes, resets or benchmark substitution.
The accepted scope fixes cohort accounting before launch instead of deleting
tracked history or introducing a synchronization barrier.

## November 7 Google400: retired standalone headroom remained in ticket admission

After the full-width accounting repair, campaign `b12b2d7c...` committed and
released all14 cleanup claims and retired its budget. It failed later because
the current schema's canonical PG15 seed was not published; it earned no task
credit. After both schema-current seed publications, campaign `46904a5e...`
failed before any controller launched with `cleanup_ticket_failure=prepare`.
Only `prepare.lock` existed; no budget, grant or per-member claim had been
written. The original exception and atomic free-space observation were not
captured, so that historical error remains UNKNOWN.

Readonly accounting nevertheless exposed a concrete admission defect. The
filesystem's legacy ledger still retained ten consumed standalone owners from
75588, all with absent native PIDs. Its bytes were unchanged. The ticket helper's
`legacy_liability` charged2560MiB of working headroom indefinitely, while the
legacy allocator's own budget uses live consumers. At the later observation,
6,919,761,920 free bytes were below the7,214,202,880 bytes demanded by those
retired floors plus15 slots (14owners and one nested canary) at unchanged
32MiB cleanup minimum and256MiB working headroom. No dangling cold grant existed.
This recalculation is current evidence, not a replacement for the missing
original atomic sample or proof that a parallel PG16 publication caused it.

The owning regression gives the real ticket CLI a private6500MiB volume,
14members and ten spawned-then-joined standalone owner records. Original source
fails the physical-floor check; the candidate admits the cohort with unchanged
512/32/256 policy and exact historical ledger bytes. Only strictly valid
standalone consumed owners with positively absent processes and no associated
inflight allocation can stop contributing working headroom. Live or reused PIDs,
permission/observation failures, pending members, cohorts and allocator debts
retain liability; malformed records fail closed. No process, reserve file,
provider resource or historical ledger record is removed.

Fifteen helper tests pass, including all11 original tests, both stored birth
formats, unknown/live/reused/debit controls and exact no-process `ps` semantics.
All28 campaign tests pass. A separate causal fault-injection regression requires
ordinary preparation failures to retain the actual exception class and a bounded
message, omitting subprocess argv, OS filenames, tracebacks and injected bodies.
The original producer lacks that field; the candidate passes all three injected
exception classes. Strict startup behavior and its original tests are unchanged.
Candidate patch and logs are recorded in
`.context/rca-google400/stale-dead-candidate/handoff.json`.

The candidate's readonly calculation over the actual ledger removes only the
retired working-headroom charge; its SHA256 remains
`f4c13463773c3d041e1e7422104aac1f80d3b1c4064f284b02b9dd4dd0bb6baf`.
The normal typed zero-controller cleanup reconciliation subsequently completed
with no acceptance credit; the original native outcome remains unchanged.
Combined cycle tests passed 228/228 and all12 worker Prisma clients were prepared
through the normal dependency command after the last owned worker retired.
Final combined-source gates and a fresh real cloud smoke remain pending. This
recurrence does not establish the uncaptured historical exception or claim
production Google/phone acceptance.
