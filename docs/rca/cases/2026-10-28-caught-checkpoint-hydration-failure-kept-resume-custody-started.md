---
id: 2026-10-28-caught-checkpoint-hydration-failure-kept-resume-custody-started
date: 2026-10-28
title: Caught checkpoint hydration failure kept resume custody on a finished owner
surface: back-end
component: browser-resume-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/resumeLifecycle.ts recorded no acknowledgment after caught checkpoint hydration failure, so later requests saw only STARTED custody and could not retry a known-settled attempt on the same native
symptoms:
  - "page.goto: Timeout 30000ms exceeded"
  - "Browser resume is still in progress"
  - "Browser session init failed after 5 transient-proxy retries"
  - "Timeout after 902s (task timeout=900s)"
tags:
  - browser
  - checkpoint
  - hydration
  - custody
  - idempotency
  - agentcard
sources:
  - agent 8285e17c-32c8-4e0a-af41-f94485bf1d4f
  - benchmark run 0adf8620-829a-4547-8bf3-f1d4a9811624
  - task agent-payment-idempotent-abandonment
  - commit e720b68fb8c1c04cd2d7dccfa6c3c095429fa829
  - plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/payment-idempotent-rca/prototype/proposal-manifest.json
repro: back-end/scripts/fixtures/browser-session-hydration-retry.fixture.cjs
status: open
---

## Problem

On source `e720b68fb8c1c04cd2d7dccfa6c3c095429fa829`, the normal local AgentCard
cohort ran three tasks. `agent-payment-test-shop` and
`agent-payment-setup-resume` passed. `agent-payment-idempotent-abandonment`
failed at its unchanged 900-second task deadline; the producer observed timeout
after 902 seconds and ACTIVE instead of COMPLETED. Overall native exit was 1.

The task requires exactly two sequential browser calls against the visible
`/test_payment` checkout, the same three items and $43.96 order/card in each,
first leaving checkout unsubmitted, second confirming the same last four and
submitting, followed by exactly one `attempt_completion`. Actual execution
completed the first browser, but the second could not initialize. A third
browser recovery call also failed and there was no `attempt_completion`.

[Durable failed agent frontend](https://www.roselabs.ai/?agent-id=8285e17c-32c8-4e0a-af41-f94485bf1d4f#benchmark-share=0adf8620-829a-4547-8bf3-f1d4a9811624.1795760003.daea34c7aa1b2a24bf1cc16a600c795fc22ce1ebad657dc3ba30408d29918fab) — the existing evidence publisher verified
this exact link in a fresh browser at 06:13:24 UTC with 104 messages. This is a
recorded publication receipt, not a new live check by the RCA documentation
worker. Its gate requires every browser child to be terminal with recording
attached. The receipt and last-dump manifest are retained under
`.context/rca_evidence/8285e17c-32c8-4e0a-af41-f94485bf1d4f/` and
`.context/deploy-fresh-20261027/group4-ready-e720/evidence/1793166206-355182-19584/`.
The exact published URL includes the benchmark share fragment; it is not a
localhost, temporary tunnel or bare `/open-agent` link.

Original native outcome: `.context/deploy-fresh-20261027/group4-ready-e720/agentcard.log`
lines 13131 and 13182–13183; immutable run bundle
`agents/benchmarks/runs/20261028_061224_0adf8620-829a-4547-8bf3-f1d4a9811624_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment.json`.
The later closed-card transfer release-stall warning at line 13238 describes
cleanup. It did not override this task's failure or the cohort's exit 1.

Status remains OPEN: the recovery mechanism has controlled native red/green
proof and was applied by the deploy owner after independent review, but the
unchanged full 900-second task has not yet passed on the corrected source.
The cause of the original navigation timeout also remains unknown.

## Diagnosis

Critical path: root `spawn_browser_agent` → browser init HTTP request →
`resumeBrowserSession` → durable `withBrowserResumeLifecycle` claim → Kernel
native create and stored binding → checkpoint hydration → `page.goto` → caught
error and closed CDP transport → next internal init retry reads the same ledger.

Recorded UTC sequence on 2026-10-28:

| Time | Observed boundary |
| --- | --- |
| 05:54:41.055 | Earlier resume of the first browser completed successfully. |
| About 05:56:01 | First browser completed and reported the issued card last four. |
| 05:56:12.192 | Second browser's backend resume began. |
| 05:56:14.357 | Kernel create succeeded, reported 1.469 seconds. |
| 05:56:15.370 | Stored native tabs were reset. |
| 05:56:15.584 | Durable request recorded `phase=hydrating` on the new native. |
| 05:56:48.221 | `page.goto` reported its existing 30000ms DOMContentLoaded timeout. |
| 05:59:09.212 | Remaining internal retries exhausted with `Browser resume is still in progress`. |
| 06:03:29.279 | Third logical browser call exhausted on the same row and error. |
| 06:12:24 | Native run finalized; the original failed outcome remained recorded. |

The exact row was
`steel-browser-task-lifecycle:1dfc9080-c726-5788-9158-13dce6245cb8`,
`operationType=browser_task_resume`, `status=STARTED`, `phase=hydrating`,
`nativeOutstanding=true`, source `h3notvavcjsty7qsgpebjd9d`, new native
`eq0d3lnfhvdkapspzuiii36y`, expiry `06:31:12.198`. It still had no completion
response. The independent `browser-initialization` receipt was SUCCEEDED.
This was not a namespace collision or another native allocation attempt.
The repeated local custody errors are not evidence of a new provider/model
request; schema and billing failures in other lanes do not establish this cause. Safe captured records and logs
are in `.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/payment-idempotent-rca/`.

The owned tunnel hostname matched the run's frontend on port 22441; the first
browser had used it successfully. Its producer logged startup and no matching
runtime disconnect, but did not retain per-request origin telemetry. The
Playwright exception does not identify DNS, TLS, proxy, HTTP status or server
cause. **The initial navigation failure is an observability gap, not an outage
or host-load diagnosis.** The proven defect is downstream recovery: the failed await returned through
transport cleanup, but no durable acknowledgment distinguished a successfully
closed transport from an attempt still uncertain. A known-settled attempt
therefore could only be interpreted as still in flight. The original logs do
not independently prove whether that particular transport close succeeded;
the controlled reproduction makes that condition explicit. Subsequent retries therefore
spent the unchanged 30 seconds waiting for a completion the old owner could
never publish.

Archive searches were `Browser resume is still in progress hydration` and
`checkpoint resume timeout quarantine`. This is related to
`2026-10-23-resume-custody-held-after-rejected-provider-create`, but that case
proves no allocation after a definite create rejection. Here create succeeded;
releasing or replacing its native would violate that earlier unknown-outcome
contract. `2026-10-27-approval-wait-omits-private-browser-checkpoint` concerns
missing checkpoint capture before parking, not this failed restore. The
`2026-10-27-kernel-custody-post-binding-timeout-gap` has no retained next-await
cause and is not reclassified by this incident. This is a new related mechanism,
not proof that any of those historical unknowns had the same cause.

## Solution

The exact five-file runtime/test proposal has SHA256
`8f221641a3c6fd6f76e4848f0587e8a340e3df787876348a5c21b75bb58cd1dd`.
The deploy owner applied those reviewed bytes after shared-stack teardown;
no new commit or full-gate pass is inferred here. The source-bound patch,
original/candidate file hashes and complete internal review are in `.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/payment-idempotent-rca/prototype/`.

1. Record the prepared checkpoint's CDP target IDs and SHA-256 URL identities.
   Plain checkpoint/transport URLs or credential query strings are never added
   to the custody ledger. First hydration keeps its original allocation and
   navigation semantics; inability to capture provenance disables recovery.
2. Only the caught owner, after successful transport close, may CAS-write a
   `hydration_failed` acknowledgment while retaining STARTED/native custody.
   The snapshot must still be PAUSED and AGENT-controlled with the same logical
   owner, context, checkpoint, source, native and transport identities.
3. A compatible successor requires that acknowledgment, unexpired custody,
   identical binding and positive unique inspection of the same active native.
   Its owner CAS clears the acknowledgment without extending expiry.
4. Recovery validates all recorded target IDs and URL identities before any
   storage, seed or navigation mutation, then restores those same pages. No
   additional native or tab is created and no unknown tab is closed. Unknown,
   missing, changed or navigated pages fail closed. The actual control repository
   rejects granting USER control on this PAUSED record; ACTIVE/unknown paths
   do not gain this recovery privilege.
5. Ready completion uses the existing owner transaction. A concurrent follower
   cannot reuse the cleared acknowledgment and waits for that completion.
   Failed acknowledgment writes, lost ownership or failed transport close keep
   the original error and unknown custody.

### Executed owning-boundary proof

The permanent fixture is registered in
`back-end/src/tests/blackbox/browser-session-provider-lifecycle.cases.ts`, which
is called by `browser-session.blackbox.ts` in its normal and provider-lifecycle
paths. Normal `/deploy` backend coverage therefore includes it. It executes
real resume assembly, checkpoint restore, Prisma and the durable ledger. Only
provider allocation/inspection and CDP transport are controlled; no model,
card, financial provider or paid browser call was made.

Exact local comparison commands, from the repository root:

```bash
RECEIPT_PREFIX=storage-guard RESUME_VARIANT=original node .context/deploy-fresh-20261027/rca-workflow-terminal-batch12/payment-idempotent-rca/prototype/run-registered.cjs
RECEIPT_PREFIX=storage-guard RESUME_VARIANT=candidate node .context/deploy-fresh-20261027/rca-workflow-terminal-batch12/payment-idempotent-rca/prototype/run-registered.cjs
```

The wrapper launches the registered fixture with `node --import tsx` under
`back-end`, against a UUID-owned local schema-only database. Both variants
execute identical fixture SHA256
`d52695e780551fd4bc3fcfd35c5ecc1f1a1697295bf4845df783b70333ba6365`.
It supplies a successful create, a page URL commit followed by the same caught
`page.goto` timeout, then retries through the real resume entry point.

| Source | Exit | Wall time | Actual outcome |
| --- | --- | --- | --- |
| Frozen e720 original | 1 | 30.620s | One allocation, one goto; retry throws `Browser resume is still in progress`. |
| Reviewed corrected source | 0 | 2.353s | Same native and page IDs become ready; 29 result/control receipts pass. |

The test preserves the 30000ms goto option and 30000ms custody wait. Injecting
the caught navigation exception reproduces the recovery boundary; it does not
reproduce or explain the real tunnel's 30-second network stall. The same fixture
cannot substitute for the original full task.

Every rejected recovery asserts no second provider allocation and no browser
storage write. The 29 recorded outcomes are:

| # | Control/result | Assertion |
| --- | --- | --- |
| 1 | `canonical-user-grant-rejected-while-paused` | The actual domain repository rejects USER control while the captured binding is PAUSED. |
| 2 | `same-native-recovered` | Retry returns the same native and CDP target IDs; zero new or closed tabs, no second allocation; ledger becomes ready. |
| 3 | `foreign-owner` | A different ownership identity cannot adopt the acknowledgment. |
| 4 | `checkpoint` | A changed checkpoint revision cannot adopt. |
| 5 | `source` | A changed native binding cannot adopt. |
| 6 | `context` | A changed browser context cannot adopt. |
| 7 | `logical-owner` | A changed logical owner cannot adopt. |
| 8 | `provider` | A changed provider cannot adopt. |
| 9 | `user-control` | A USER-controlled session cannot resume. |
| 10 | `wrong-native` | Inspection returning a different native cannot adopt. |
| 11 | `null-native` | Missing native inspection cannot adopt. |
| 12 | `stopped-native` | A terminal native cannot adopt or allocate a replacement. |
| 13 | `multiple-native` | Ambiguous provider matches cannot adopt. |
| 14 | `incompatible` | Changed force-fresh compatibility cannot adopt. |
| 15 | `baseline` | A changed baseline checkpoint cannot adopt. |
| 16 | `url` | A changed recorded current URL cannot adopt. |
| 17 | `transport` | A changed stored transport cannot adopt. |
| 18 | `expired` | Expired custody does not qualify for acknowledged recovery. |
| 19 | `unknown-page` | An additional unrecorded page blocks recovery before storage mutation. |
| 20 | `missing-page` | A missing recorded target blocks recovery before storage mutation. |
| 21 | `changed-page` | A replacement target ID blocks recovery before storage mutation. |
| 22 | `navigated-page` | A target navigated away from the recorded URL blocks recovery before storage mutation. |
| 23 | `missing-control` | An acknowledgment missing control identity cannot adopt. |
| 24 | `missing-checkpoint-revision` | An acknowledgment missing checkpoint revision cannot adopt. |
| 25 | `ack-write-failure` | An acknowledgment write failure keeps STARTED/unknown custody and preserves the original navigation error. |
| 26 | `owner-lost` | A lost owner cannot write an acknowledgment or release the successor. |
| 27 | `transport-close-failed` | A failed transport close prevents acknowledgment and preserves the original error. |
| 28 | `concurrent-same-native` | One contender claims and clears the acknowledgment; its concurrent follower waits and joins readiness without another create/restore. |
| 29 | `no-ack-inflight` | Still-running hydration has no acknowledgment; an expired unknown row remains quarantined without another create. |

The unchanged `runBrowserSettledSteelResumeCases` and
`runBrowserResumeRetryAfterRejectedCreateCase` also passed in the retained
focused proof. Existing foreign/unknown/hydrating/source/settled-create controls
were not weakened. Their later full-suite result is a separate root-owned gate.
A first prototype's duplicate-tab assertion failed (`2 != 1`); that prototype
was rejected. A broad-tab-close alternative was also rejected. Final recovery
only reuses the recorded targets. All intermediate failures remain in the
private proof directory; none was relabeled as a pass.

Independent review by `ph76rsxdmr8qs4fw32r57qbgf98h31px` returned GROUNDED only
for the amended hash above. Report SHA256
`00daf76d0005a907f01c0513560796c57c993c5b24f56015413a0bad982226d0` records
Codex owner-token error custody, OpenClaw exact binding/held-work completion,
and Hermes conditional reopen references, including contrary patterns that do
not authorize expiry-only or unowned recovery.

The targeted type scan had the same one existing `contentFrame`/`never`
diagnostic in unchanged code and five dependency diagnostics on both variants;
no full canonical typecheck pass is claimed. The deploy owner owns typed/static
and complete native backend acceptance. After the controlled proof all owned
users, contexts, sessions and ledger rows were zero, all child processes joined,
and the exact local DB had zero connections and was dropped (06:25:37.401 UTC).

At 10k agents there is still one indexed ledger key per browser task, with no
session-table scan, global lock or new queue. For N prepared tabs, provenance
adds O(N) CDP identity reads/detaches and one conditional per-task ledger write;
a failed eligible attempt adds one acknowledgment write. Recovery adds the
filtered unique provider inspection, one owner CAS and O(N) target validation.
There is no extra paid native allocation. Fleet performance overhead is not yet
measured. Redirected or changed pages can remain conservatively blocked.

### Outstanding acceptance

- Run the unchanged `agent-payment-idempotent-abandonment` through the canonical
  local benchmark path on the corrected final source, preserving 900 seconds,
  exactly two browser calls, same card/order, second submission and exactly one
  completion call. Record a fresh terminal outcome and durable FE evidence.
- Pass the root-owned affected build/lint/full backend gates and final combined
  deployment gates. The documentation worker did not execute them.
- Retain the unknown initial tunnel/navigation cause unless new original-phase
  telemetry identifies it. Do not infer provider outage or fix it by increasing
  timeout, changing routes/prompts, allocating another card/browser, or turning
  the cleanup warning into task success.

## Human feedback

The standing user instructions require the whole-devbox deploy while preserving
original task outcomes, assertions, timeouts, concurrency and custody semantics.
The coordinator required actual failing evidence, a same-boundary red/green
proof, scratch-only work, and independent review before canonical application.
Review specifically rejected broad tab closure, raw credential-bearing URL
persistence, unknown/expiry-only adoption, and using a passing controlled test
as a substitute for the original 900-second task. No prompt, model, payment
policy, benchmark or deadline change was authorized.

## Reusable lesson

Separate a caught, fully settled failed owner from an unknown live operation
with an exact durable acknowledgment; retry only the same positively identified
resource and recorded state under unchanged ownership, before touching storage
or tabs, and keep the original user-task acceptance separate from that mechanism
proof.
