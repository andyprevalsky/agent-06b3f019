---
id: 2026-11-03-browser-smoke-pre-task-compute-refresh-unresolved
date: 2026-11-03
title: Browser smoke aborted before task creation on missing usable Claude sync and never produced sealed runtime evidence
surface: harness
component: benchmark-compute-preflight
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: run-level compute refresh before browser-smoke task creation; seed-local.ts returned No usable claude_code integrations after sync five times, but original eligibility and fallback response are not captured
symptoms:
  - "No usable claude_code integrations after sync"
  - "RuntimeError: Benchmark run could not refresh local compute tokens"
  - "HTTP Error 409: runtime evidence is incomplete or changed"
  - "no current run artifact produced"
tags:
  - benchmark
  - compute-token
  - claude-code
  - runtime-evidence
  - preflight
sources:
  - commit 3625eccd4952388c56e979c6a61045dff1c7804a
  - commit 15251fd54e5bf9b5b88fa5e733ccda261e881be5
  - fleet run 20261103-080439-310057
repro: private /var/tmp/pr1662-3625-full-browser-rca/seed-control.cjs
status: open
---

## Problem

Current3625 full smoke browser-smoke j0006 began its run-level preflight at
08:24:58 UTC and failed compute-token sync five times. At08:25:28 the runner
raised Benchmark run could not refresh local compute tokens before creating
any task agent. No task run.json/cloudbench-run.json/report-card exists.
The native monitor error/evaluation category was not an evaluated browser
assertion. The300s/50c task budget was not the failure boundary.

## Diagnosis

Gate UNKNOWN for the whole current failure, compared actualmain/merge-base
15251fd54e5bf9b5b88fa5e733ccda261e881be5 ->3625eccd4952388c56e979c6a61045dff1c7804a.
Conditional seed-guard mechanism Gate NOT_INTRODUCED only: exact seed source
and owning Python helper ASTs match. Actual immutable retry-function controls
with mocked sync/counts reproduce the same five-attempt error on both refs;
a modeled usableClaude1 returns. No historical eligibility or taskPASS follows.

This is Claude sync, not the preceding GPT judge cooldown. Eligible Claude
rows require CONNECTED, encrypted credentials, and task-user/active remote
pool eligibility. The exact original local post-sync eligibility/counts and fallback
readiness response were not retained. Parent08:34 aggregate later records
all production Claude rowsEXPIRED, updated02:07/Oct31 before the failure;
this closes the recorded production-state gap, not the fallback-response gap. The fallback predicate can returnFalse
for unavailable configured fallback, non200/malformed response or exception.
No expiry, auth_error, quota or outage is proved.

The narrow non-Claude seed flag exists, but only the AgentCard lifecycle
launcher exports it. Generic sync copies inheritedenv and does not emit it;
it emits the separate funded-fallback tolerance only after readinessTrue.
Browser-smoke requires_claude_code=false, which is passed to refresh. This
propagation fact does not justify an unproved broad flag/configuration fix.
Historical July6 pool-auth and September10 fallback-handoff cases are symptom
relatives only; no common configuration cause is established here.

The later runtime409 is secondary and its exact rejected file/validation is
unknown. The status server requires services/run/stack/backend/worker/cleanup
identity; the sealed manifest was never collected. Nativechild70/controller1,
lifecyclefailed/auditSHAempty, canonical auditincomplete/no releaseepoch remain.
Exact machine7811175da67d48/volumevol_4ql108eypql8edwr is recorded as
destroyed-provider-retained, not absent; guest cleanupACK and retainedHub314372
owner/birth obligation persist. Parent/ph74 own recovery.

Native infra-stop at08:26:20.068050 after j0006 cancelled13siblings. All14
UNVERIFIED occurrences and per-job evidence are preserved separately. Some
siblings reached benchmark, but no fresh task artifact is captured; do not
invent assertion failures or claim all task execution was absent.

## Solution

OPEN for native task coverage and cleanup; keep wholeUNKNOWN, all14UNVERIFIED
and original failed lifecycle. The bounded evidence-only investigation stopped
at missing local eligibility/fallback/sealed-runtime evidence without retry.
Parent then authorized a separate minimum private mechanism repair: derive the
existing non-Claude seed opt-in only from explicit nonempty selected tasks with
no requires_claude_code and require_claude_codeFalse. A tri-state helper keeps
legacy AgentCard default/live-fixture inheritance, explicitly clears ambient
permission for strict/empty/mixed refresh, and scopes new permission to the
seed subprocess. Each task flag must be literalFalse and helper permission
literalTrue. The updated same owning test refuses unknownNone catalog flags
and integer1 helper permission; this refusal failedv1 then passedv2.
Only that changed owning test was rerun after the literalboolean delta;
7unchanged v1 controls were not repeated. Existing direct-token cost assertion, API fallback semantics,
provider runtime, seed retries and all task assertions/budgets remain.

The real new registered owning benchmark test failed on3625, then it plus7
existing fallback/source controls passed on the candidate with socket network
blocked. Controls include strict Claude/mixed/required/empty refusal, explicit
BENCHMARK_REQUIRE_COMPUTE_TOKENS enforcement, and legacy default+actual live
fixture compatibility. Registration is benchmark.blackbox.py record_async at
26903, definition13224. Initial sparse-export import failures are separately
retained and are not the functional fail-first proof.

Private2file patch SHA256072808d024667fe02bc6c454a8f480018670801041e4f884093bd1f516296aa1
has11 production lines in3hunks. Pristine3625 apply-check passes. Candidate
report-v4 SHA2561bbb31efabceb69187da1aec39fc3315cefe3cd332f01568fdd3536725609f74
is under /var/tmp/pr1662-3625-nonclaude-fix. This proves permission propagation
and strictness/compatibility only, not historical fallback recovery, usable
live credentials, browserPASS or completed cleanup. Parent alone integrates;
all original14UNVERIFIED outcomes and incomplete native owner remain. Packet /var/tmp/pr1662-3625-full-browser-rca/report.json SHA256
4f54201f56ac96fef648d38ead08e7de0801c3626458c404daad50bb35c2d8fa.

The parent integrated the reviewed v2 mechanism repair after merging actual
main at 191b3fd83535e2e1621cf860a696225cdf33b161. All eight selected owning
controls passed against the integrated source with socket network access
blocked, and the archive validator passed. Native task coverage and retained
cleanup ownership remain unresolved; these controls grant no task credit.

## Human feedback

The delegated scope requires saved evidence only, preserving Freedom, source,
credentials, task assertions/budgets and native outcomes. No broad credential
skip/global environment change or inherited provider exception is authorized.
Parent owns live operations and a separate owner prepares exact cleanup.

## Reusable lesson

A monitor error/evaluation bucket cannot substitute for a fresh evaluated
task artifact. Separate pre-task credential refresh, later evidence transport,
and native sibling cancellations. Source parity can prove a conditional guard
unchanged while the actual configuration cause remains UNKNOWN.
