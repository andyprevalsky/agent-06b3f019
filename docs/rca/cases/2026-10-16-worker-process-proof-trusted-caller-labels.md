---
id: 2026-10-16-worker-process-proof-trusted-caller-labels
date: 2026-10-16
title: Worker process certificates trusted caller labels instead of publisher and execution ownership
surface: back-end
component: worker-process-deployment-proof
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: shared repository.record published backendRecovery for CLI observations based only on Render environment labels
symptoms:
  - Missing expected rejection
  - Candidate fixture executed on an unqualified native worker
  - Existing Machine instance identity is absent or conflicting
tags:
  - deployment
  - existing-machines
  - evidence
  - native-identity
  - recovery
sources:
  - PR #1518 development stabilization
  - commit 1419ecb571746d3d19bb4c9edc3c29f36d2566c6
  - commit 981f7fc48e4ae0c073cb7623391ddbb0a1e14702
repro: back-end/src/tests/unit/worker-process-deployment.test.ts and worker-process-recovery-postgres.test.ts
status: open
---

## Problem

The frozen development controller had two certificate gaps found during bounded
independent source inspection. The same repository writer served CLI observation
and backend cron. Render environment fields therefore let a CLI observation mint
the certificate intended to prove independent backend recovery. The native
candidate fixture also stamped source/bundle labels from its caller without
binding task execution identities from workflow history to the attested workers.

No production candidate was launched and no activation or pointer change occurred.
These are repaired development boundaries, not claims of a production incident
or completed native kernel, coexistence, recovery or eight-worker qualification.

## Diagnosis

Both paths confused intended identity with independently observed ownership.
Source labels and worker inclusion establish necessary inputs, but do not prove
which producer recorded recovery or which worker executed a fixture.

The actual local Postgres fixture exercises the production registration,
reconciliation, record and certificate consumer owners through real transactions.
Native/Render external facts remain explicitly mocked. With the earlier
Render-fields publication predicate restored as an assertion mutant, the fixture
reports three controls PASS and the CLI-cannot-publish assertion FAIL (`Missing
expected rejection`). Restoring the separate cron-only publisher makes the exact
same four-case fixture PASS. This is a predicate-scoped causal proof, not a claim
that an entire old production build was executed. A later additive control also
requires a fresh RUNNING backend observation for final verification.

The actual activation-receipt validator from frozen1419 was swapped alone into
the final test context. The same seventeen-case fixture reports sixteen controls
PASS and rejection of a foreign executor FAIL. The repaired validator reports
seventeen PASS. Native history attribution controls reject foreign/missing
workflow and activity executors. These are offline boundary proofs; the real
canonical production fixture remains required. An earlier fixture-extraction
missing `randomUUID` import was corrected before the clean causal pair and is
not causal credit.

A separate native-shape control also found that the transport cast raw Machine
JSON while callers required `version`; the provider can return `instance_id`.
Actual-shape transport plus reconciliation failed before normalization and passed
after it. Missing/conflicting identities still deny. The earlier mocks supplied
an internal field that hid the boundary mismatch.

Archive searches used `Machine instance_id worker version` and `deployment
recovery certificate caller labels worker identities`. The prior partial-merge
recovery case concerns a missing dispatch entry point, a relative with a different
first bad boundary. It does not establish this certificate diagnosis.

## Solution

Only the configured backend entry point can publish backend recovery evidence;
ordinary CLI observations preserve an existing certificate but cannot mint one.
The backend must match the retained Render service, database host/name and source,
with actual Render instance fields and a nonlocal production database. A copied
record in a local/benchmark database or another service cannot authorize IO.
The consumer checks active intent custody, source, service, freshness and all eight
exact processes. Final verification specifically requires its RUNNING phase.

The candidate fixture retains its existing initialization, determinism, durable
state and cleanup assertions. The process route additionally reads qualified
standby receipts and native workflow/activity task execution identities from
history. Foreign executors/pollers and a changed pre-activation cohort deny.
Receipts are written only after successful canonical cleanup and lease release.
Machine transport normalizes native identity at its owning boundary.

No old process, Machine configuration or queue retirement is introduced. Old queue
admission remains OPEN and served for protected runs and later descendants. The
new controller holds one retained deployment record and observes exactly eight
hosts; its work does not grow with the number of agents. The existing indexed
admission repair remains separate. No mocked 10k or native performance claim is
made for these process fixtures.

Local real-Postgres schemas and databases are explicitly owned and dropped after
all connections are joined; source/proof receipts are retained. Full composed
source checks, fresh deployment review and actual production verification remain
open.

## Human feedback

The user required finishing deployment with existing Machines. They did not
waive private credential isolation, protected work, activation/MIN8, verification
or Freedom preservation. They did not authorize fresh allocation or canceling
real workflows. The two certificate gaps were independent-agent findings, not
invented user feedback.

## Reusable lesson

A deployment certificate must bind its actual producer and native execution;
caller-supplied labels and presence in a poller list do not establish either.

### Backend review fixes — d34ff0b00321ae0c3198c9cd44273a2515bf4f85

Exact parent 2bb1cd7583c710dae755c72b53489fc154395ff8. Findings 4293587146 and 4293587157. Prepare native workflow args before admission so a synchronous preparation error produces zero journal membership and zero native starts; preserve all existing actual native/ACK ambiguity handling. Backend service revision is independent of retained worker artifact revision; require valid actual backend 40hex provenance while preserving ACTIVE full-plan/service/database/auth/worker receipt checks. No runtime model or USER text change.

Final unchanged owning fixtures, with only the two actual runtime owner files source-swapped: exact2bb has five target assertion failures (queue1/envelope3/deployment1) with all remaining controls passing; candidate has queue14/envelope7/deployment23 PASS. Additional unchanged replacement orchestration10 PASS. Full backend tsc, six-file ESLint, Prettier, diff and raw three approval guards PASS. No approval flags.

Commands run from back-end with DATABASE_URL and DIRECT_URL deliberately disabled at localhost9: `node --import tsx src/tests/unit/{workflow-queue-admission,worker-process-envelope,worker-process-deployment,workflow-replacement-orchestration}.test.ts` (each actual named file separately). No real SQL proof. Actual PostgreSQL fixture requires root-owned DB verification; attempted replacement-state setup against disabled DB is preserved as a noncausal setup failure and not counted.

Root owns final combined qualification, formal review and deployment. Source proposal only; 8940 cleanup decision remains independent.


### Composed verification of backend revision independence

The complete e62c44b75c229a129dd0316a12731642c318c361 Test Loop passed the normal
backend unit/blackbox and actual PostgreSQL recovery owners after the d34 fixes.
The retained immutable worker artifact remains independent of a later valid
backend revision; source/service/database/custody checks and native execution
identity requirements remain enforced. This is actual local integration proof,
not an independent production backend recovery certificate or eight-process
activation result. Production qualification and the explicit stopped-peer
disposition remain open.
