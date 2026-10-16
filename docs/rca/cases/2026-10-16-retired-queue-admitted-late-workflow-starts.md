---
id: 2026-10-16-retired-queue-admitted-late-workflow-starts
date: 2026-10-16
title: Late workflow starts could reach an old queue after worker retirement
surface: back-end
component: temporal-queue-admission
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: startAgentWorkflowExecutionWithClient admitted explicit or in-flight old-queue starts without durable membership checked by the worker retirement owner
symptoms:
  - actual helper admitted retired old destination
  - old native RPC accepted after actual retirement owner permitted zero-poller closure
  - ACK changed admission membership without waiting for the terminal generation lock
tags:
  - temporal
  - deployment
  - queue-admission
  - late-ack
  - concurrency
sources:
  - PR #1518
  - commit 3677693be884dd4f866f6a09369c984dd19d4db0
  - commit 6b0c7e1a88585b0ff31b7f38d406ec1fd22da4af
  - commit 91574c11276dc5ee51b76f3acea962df09eb4c81
  - commit 84a2fcf30147b349af4dfd571267e932d353201a
repro: back-end/src/tests/unit/workflow-queue-admission.test.ts and workflow-queue-admission-postgres.test.ts through the normal local backend unit runner
status: open
---

## Problem

The final review of the credential deployment found that visibility-zero drain
could retire the old workers while an explicit old-queue start or an earlier
native RPC was still admissible. The stopped367 deploy remains review-unstable;
these development repairs have not been merged or activated in production.

## Diagnosis

The shared start helper trusted an explicit queue and used a cached pointer for
ordinary routing. Neither decision joined the retirement transaction. Native
acceptance can precede visibility indexing or arrive after an ambiguous response.
The missing owned boundary was durable admission membership, independent of a
workflow-count sample, cache expiry or deployment lease expiry.

Liveness cleanup had a related ordering gap: it could act on an older closed
status while a start or acknowledgement changed the same agent's membership.
The final comparison and claim/ACK writers now share the keyed generation lock.

## Solution

The published membership-only repair closes queue admission monotonically,
records each start before native RPC, retains accepted chain identities, and
requires positive reconciliation before retirement. Unknown legacy coverage and
reusable-root wire ambiguity remain blocking. It preserves the SDK retry owner,
root IDs and actual error text; it does not implement native-frame replay.

The composed55f development source passed four real PostgreSQL cases in isolated
schemas: commit visibility and exclusive closure, per-agent versus independent
admission, ACK serialization, and the actual per-agent Prisma query using the
existing externalId index among10,000 real rows. The unchanged lock fixture
b7357a4f failed on the unlocked ACK writer and passed with915. The final unchanged
four-case fixturec51814f2 failed the index-access assertion on915 and passed
with84a. Earlier raw-query instrumentation errors are preserved separately and
are not counted as invariant evidence. No production schema/index migration or
provider/workflow/Machine action was used.

The normal recursive unit runner includes the real PostgreSQL fixture. It
requires an explicit loopback database, creates only a randomly named schema,
and removes that schema and joins clients afterward. The table indexes mirror
the existing ToolSideEffect Prisma model. This proves SQL/lock/access-path
behavior; it is not a production load test or legacy bootstrap certificate.

Composed-source integration additionally typechecked the CLI and owning unit
fixtures explicitly: the normal backend tsconfig excludes scripts and tests.
Partial database mocks now declare their intentional type boundary, and the
batch fixture uses the supported WEB source with explicit pause_state=false.
All assertion ASTs are unchanged; the 13 owner cases and 12 actual-caller cases
passed again on offline mocked boundaries. The real PostgreSQL test bodies are
byte/AST preserved from c518; only its top-level fatal error reporter changed
to satisfy the existing console lint rule. These checks do not replace native
production qualification.

The historical source-proposal notes below are preserved verbatim from their
original location. Their successive counts identify their respective snapshots.


### October 16 deployment follow-up: durable old-queue admission membership

PR1518 verification review 5543231600 on immutable
3677693be884dd4f866f6a09369c984dd19d4db0 found a distinct deployment race:
explicit old queues bypassed cached pointer routing, and a native start already
in flight could acknowledge after a visibility-zero retirement decision. The
original review remains closed with findings; this proposal is development
work and does not reset or add a review cycle.

A bounded repair journals each shared-helper start before its native SDK call.
Starts take a shared routing lock and a keyed Agent-generation lock; queue
closure takes the exclusive routing lock. Native RPCs and chain reconciliation
run outside those locks. New starts requesting a closed queue may route only
to the freshly read current pointer's verified OPEN queue. Publishing a pointer
and its OPEN admission state shares the exclusive transaction; closed queues
cannot be implicitly reopened for rollback. Retirement retains its durable
RETIRED tombstone rather than clearing the barrier.

The production cutover now calls the closure owner before measuring drain and
the exact retirement owner before its first old-Machine stop. Retained pool
reuse also requires the source retirement certificate. Visibility zero alone
cannot satisfy the new owner: every journaled start must have a positively
reconciled immutable native chain, with unchanged membership and gate custody
at final commit. Missing queue identity, a mismatched first run, unresolved
native/ACK writes, and unknown legacy coverage all deny retirement.

This is deliberately a membership-only proposal. It does not persist/replay
encoded native frames, observe every gRPC wire attempt, or change SDK retries.
The installed SDK retries below the public service wrapper. Therefore a
preserved ALLOW_DUPLICATE start remains UNKNOWN even after ACK and a closed
run; those intents cannot be discharged by this proposal. The narrow planned
replacement UUID now requests REJECT_DUPLICATE, while reusable legacy root
IDs retain their native policy. No code automatically certifies the complete
pre-journal producer cohort or changes UNKNOWN legacy coverage to QUALIFIED.
The actual protected parent/children and existing-eight Machine activation
remain unqualified. No native mutation or rollout was performed.

Actual shared-helper assertions fail with frozen367 temporal.ts and pass with
the candidate. The first explicit-old destination assertion observes old
versus current routing; the held-RPC assertion observes zero versus eight old
pollers. These are SOURCE-SCOPED replays: the final new admission owner and
external storage fixture remain while only the named existing source modules
are restored. They are not whole367 builds or native Temporal timing proofs.
The expanded owner covers invalid targets, ALLOW_DUP ambiguity, positive and
negative exact-chain reconciliation, unknown legacy, ACK loss, membership CAS,
pointer reactivation denial, and ten thousand independently keyed journal
entries. That ten-thousand case is an offline unit test with mocked storage,
not a PostgreSQL contention or capacity measurement.

Actual manual, SMS and batch callers exercise native/ACK failures; pending
outcomes keep rows nonterminal and do not fabricate a chat-failure turn.
Durable unresolved membership also protects the liveness read from sealing an
unacknowledged start. The installed public SDK fixture preserves converter,
interceptor, authored goal and legacy-root reuse semantics. Full direct-root,
descendant and replacement caller integration, actual PostgreSQL locking,
legacy/bootstrap qualification and current-main composition remain owning
integration gates; this evidence does not claim them complete.

The new unit files are registered by the existing recursive *.test.ts unit
runner. Normal commands from the repository root use the existing tsx binary:

```bash
node_modules/.bin/tsx back-end/src/tests/unit/workflow-queue-admission.test.ts
node_modules/.bin/tsx back-end/src/tests/unit/workflow-queue-admission-callers.test.ts
node_modules/.bin/tsx back-end/src/tests/unit/database-transaction-retry.test.ts
node_modules/.bin/tsx back-end/src/tests/unit/workflow-replacement-orchestration.test.ts
bash scripts/tests/deploy-agent-clone-recovery.test.sh
bash scripts/tests/cooperative-cutover-monitor.test.sh
```

All development executions explicitly set DATABASE_URL and DIRECT_URL to
loopback port9. Provider, HTTP, native workflow and persistence collaborators
were mocked; no paid campaign or production database was used. Final source
identity and exact raw before/after receipts belong to the handoff manifest.


The final development follow-up also closes the reviewed liveness race: after
external tool capture, terminal row acceptance and pending membership are
rechecked under the same Agent-generation serialization used by admission.
Cleanup remains outside the transaction. An actual reconciler fixture admits a
native start during that capture await and proves no FAILED write or cleanup.
For NOT_FOUND and a pre-binding stuck-chat row, even an acknowledged
ALLOW_DUP/UNKNOWN member prevents treating absence as authoritative. Existing
positive native terminal-status behavior is preserved; it is not a queue
retirement certificate. Native retirement status uses an explicit terminal
allowlist; unknown/unspecified/future statuses deny. SMS errors retain the
actual exception text rather than adding a synthetic pending instruction.
The final two offline owners each pass eleven cases. Source-scoped367 replay
has four owner assertion failures plus seven controls, and nine caller
assertion failures plus two controls. TypeScript, scoped ESLint/format, existing
sixteen DB retry cases, ten replacement cases, fake cutover/monitor and archive
validation pass. All legacy and existing-eight limitations above remain.


Final source review caught the fully acknowledged variant of the same liveness
race: a reusable root can start a new live run during tool capture after an old
CLOSED observation. The final terminal transaction now also compares the exact
Agent/workflow journal membership captured before that native status read.
Thus a new ACK, not just a pending STARTED member, invalidates stale terminal
authorization. This preserves normal reusable root policy rather than treating
all acknowledged starts as pending forever. The added actual SDK/reconciler
case confirms that the old closed run becomes a distinct live follow-up and
receives neither FAILED nor cleanup. The final caller owner passes twelve
cases. A liveness-source-only367 replay retains the new helper and final
fixtures to prove the interleaving; it is not a whole367 build.


The final bounded audit found acknowledgement was still a membership writer
outside Agent-generation serialization. A terminal transaction could compare
STARTED membership, then see a concurrent ACK at its next Read Committed
statement. The follow-up adds the same existing keyed lock before ACK reads
and writes, with no native RPC inside that transaction. The registered
ACK-owner fixture holds that external lock: unchanged6b bypasses it and fails
the assertion, while the follow-up waits and retains STARTED until release.
All twelve owner cases then pass. This is an offline lock-boundary fixture;
the deployment owner separately owns real PostgreSQL contention/commit proof.
The published6b proposal remains preserved as the before snapshot.


A bounded access-path follow-up reuses the existing ToolSideEffect.externalId
index for Agent-scoped reads: new start rows store externalId=agentId, and both
pending and membership reads constrain that exact identity. Queue retirement
filters request.queue once per source cohort, instead of every Agent poll
filtering the fleet-wide JSON journal. No schema or index migration is added;
the prior proposal has not been deployed. The registered query-shape assertion
fails on915 and passes with the follow-up; the normal offline owner passes
thirteen cases and actual caller owner passes twelve. Real PostgreSQL EXPLAIN
and contention proof remain the deployment owner's separate owning gate.


## Human feedback

The user asked to finish the credential fix, pass AgentCard benches, and deploy.
The existing-Machines-only constraint remains in force. Finishing does not imply
authority to cancel real work, allocate new Machines, waive review findings, or
claim an unsupported activation mode is ready.

## Reusable lesson

Close admission and reconcile durable membership before retiring a queue; a zero
visibility count and an acknowledgement alone do not prove no late work can arrive.

### Backend review fixes — d34ff0b00321ae0c3198c9cd44273a2515bf4f85

Exact parent 2bb1cd7583c710dae755c72b53489fc154395ff8. Findings 4293587146 and 4293587157. Prepare native workflow args before admission so a synchronous preparation error produces zero journal membership and zero native starts; preserve all existing actual native/ACK ambiguity handling. Backend service revision is independent of retained worker artifact revision; require valid actual backend 40hex provenance while preserving ACTIVE full-plan/service/database/auth/worker receipt checks. No runtime model or USER text change.

Final unchanged owning fixtures, with only the two actual runtime owner files source-swapped: exact2bb has five target assertion failures (queue1/envelope3/deployment1) with all remaining controls passing; candidate has queue14/envelope7/deployment23 PASS. Additional unchanged replacement orchestration10 PASS. Full backend tsc, six-file ESLint, Prettier, diff and raw three approval guards PASS. No approval flags.

Commands run from back-end with DATABASE_URL and DIRECT_URL deliberately disabled at localhost9: `node --import tsx src/tests/unit/{workflow-queue-admission,worker-process-envelope,worker-process-deployment,workflow-replacement-orchestration}.test.ts` (each actual named file separately). No real SQL proof. Actual PostgreSQL fixture requires root-owned DB verification; attempted replacement-state setup against disabled DB is preserved as a noncausal setup failure and not counted.

Root owns final combined qualification, formal review and deployment. Source proposal only; 8940 cleanup decision remains independent.


### Composed-source qualification — e62c44b75c229a129dd0316a12731642c318c361

The root integrated the preparation-order and backend/artifact revision repairs
with the max-steps privacy and recording-capture repairs, preserving main55f.
The fresh full Test Loop on this exact source passed: 281 backend unit files,
199 API domains, full backend types/static checks, actual PostgreSQL admission
and process-recovery fixtures, 110 agent blackbox domains, 184 cache tests,
134 agent units, 2793 frontend tests (three native skips), 46 deployment gates,
and five cold seeds with maximum159MB within the unchanged228MB limit. All
twelve canonical Linux controller commands passed, including505 selected cases.
Credential health, Amplitude and router failover passed afterward.

Current-source native smoke10/10 and AgentCard4/4 passed, as did semantic UI8/8,
real E2B and all twenty isolated latency samples. Every native owner joined;
the exact semantic stack was then retired and its processes, listeners and
isolated database positively verified absent, with system Postgres preserved.
This supersedes the proposal-only qualification limit, not the production
limit: the actual nine-host old-generation pool still denies admission, the
separate stopped-peer deletion decision is unanswered, and no candidate intent,
activation marker, queue-pointer change or production cutover is claimed.
The stopped367 review ledger remains closed with findings; this fresh deploy
uses its separate bounded ledger.

Strict current-source evidence publication then verified all14 native roots in
fresh browsers, including correctly attached recordings for every browser part
and the numerically latest recorded LLM call across each complete sealed tree.
All three native run bundles remained byte-identical; no recovered supplement
or benchmark rerun was needed for this source. Recorded task telemetry totals
36c; provider, browser and infrastructure invoices are not established by it.
