---
id: 2026-10-27-neutral-browser-init-required-auth-realm
date: 2026-10-27
title: Neutral browser startup allocated a session then rejected its absent authentication realm
surface: back-end
component: browser-session-initialization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: initSession passed exact about:blank through realm-only credential preparation after allocating the logical browser
symptoms:
  - Target URL must have an authentication realm
  - Retired logical browser cannot resume
  - Native browser task did not complete successfully
  - Browser recorded zero trajectory steps
tags:
  - browser-session
  - neutral-start
  - polar
  - credential-context
sources:
  - commit ac251b9a1f7580edaf36fb99d792df823c31ef48
  - benchmark run 2b3b92e5-af02-4cd9-8d23-04af858676e3
  - agent 87c3aa9e-b718-4041-9594-4e2cd61f2bd8
  - task R1a in parent thread ph78kfk10r8j8fpxxcp5tc43xd8h2x6q
repro: back-end/src/tests/blackbox/browser-session-logical-first-init.fixture.ts
status: open
---

## Problem

R1's explicit browser adapter passed its offline lifecycle controls but failed
its first unchanged live BU-074 proof. This is a new integration failure exposed
by the repair, not the original Campaign A provider/quota hypothesis.

The original task, raw goal, evaluator and five-step minimum were unchanged.
The parent requested one local proof with the normal 1000-cent task cap and a
7200-second execution cap. No repetition was launched after failure, and no
production deployment was performed.

## Diagnosis

Source: clean pushed `ac251b9a1f7580edaf36fb99d792df823c31ef48`.
Command: `scripts/run-bench --local polar-bu-074 --timeout-seconds 7200`.
Local run handle: `.context/benchmarks/1793127396-1034228-40127`.
Canonical run: `2b3b92e5-af02-4cd9-8d23-04af858676e3`.
Root: `87c3aa9e-b718-4041-9594-4e2cd61f2bd8`.
Native browser task: `1a6c83e2-643d-5fb5-bc5e-2d59f59c566f`.

Observed critical path:

1. At 18:57:46.142566 UTC the native browser manager starts with the exact BU-074
   goal. The adapter has selected `start_url=about:blank`.
2. Backend `initSession` reaches `initLegacySession`, which allocates the provider
   session and then calls its `prepare` dependency unconditionally.
3. At 18:57:52.516 UTC `prepareSessionCredentials` rejects the blank page because
   `canonicalAuthRealm('about:blank')` is empty. This is an owned backend error,
   before any browser action. It is not an inference provider quota error.
4. The existing initialization catch closes the just-created session with
   `pause=false`, retiring the logical browser. The four later attempts at
   18:57:57.574, 18:58:02.631, 18:58:07.699 and 18:58:12.741 UTC report
   `Retired logical browser cannot resume`.
5. The root becomes FAILED at 18:58:14 UTC. Canonical verdict: 0/1 PASS,
   34-second task duration, 13 messages, zero browser steps. The original
   missing-spawn defect is no longer the observed boundary; the browser now
   starts but cannot initialize.

The bounded correction is neutral initialization. Credential preparation for
an actual web origin remains realm-scoped. Changing the task to mention a URL,
inferring a site from its wording, substituting a search engine, or inventing
an authentication realm would hide the integration defect.

The initial mocked browser activity tests did not exercise the actual backend
session/credential boundary. This case adds that boundary to the existing
real-Prisma logical initialization regression.

Archive searches: `Target URL must have an authentication realm` and
`about:blank neutral initialization`. No identical first-bad case found.
The October 13 realm-transition case is a relative: it requires non-web pages
to publish not-applicable inventory and real destinations to use their own
realm; it does not justify bypassing web-origin credential preparation.

## Solution

Only the two initialization call sites select a new helper. For exact
`about:blank` it returns a complete, nonempty authentication-options structure
with empty realm/inventory, no readable identities, and truthful no-injection
metadata. It does not call authentication discovery, reserve passkeys, or
inject origin state. Every other URL delegates to the existing preparation
function. The public preparation API's empty-realm rejection is unchanged.

Provider creation, logical ownership, profile selection, user settings,
fingerprint retrieval, and normal resume behavior remain in their existing
owners. The worker already injects the independently returned fingerprint and
reports non-web pages as `inventory_status=not_applicable`. Its existing
navigation preparation supplies the real destination's credentials later.

Grounding packet:

| Runtime hunk | Opened source and contract |
| --- | --- |
| Initial-only neutral helper in `browser-session/service.ts` | `service.init-legacy.ts` creates session independently of realm preparation; `authRealm.ts` deliberately gives about:blank no realm; existing private-state result establishes complete no-injection metadata. |
| Complete empty auth-options payload | `AuthOptionsResponse` and `buildSessionCredentialPayload`; worker `handler.py` requires a nonempty options object to avoid its legacy inventory fallback. No credentials or identity are invented. |
| Both init call sites use helper | Existing logical first-materialization and legacy compatibility paths; public `prepareSessionCredentials` and all HTTPS handling remain unchanged. |
| Deferred credential preparation | Existing native worker non-web handling and JIT navigation preparation; origin injection must not run on blank because injection's non-HTTP fallback normalizes to HTTPS. |

Independent reviewer `ph79x0wes55k0qxakj3rtvt8yh8h3ets` marked exact patch
`3623c3fd78c05d845ba9916985716c6157e88b22b48d789163b2cb92900d03b0`
**GROUNDED for implementation**, not live outcome. The upstream V1 browser
substrate reference remains
[browser-use/benchmark@dff86d1](https://github.com/browser-use/benchmark/blob/dff86d1a32134f4bf3b38ce30ea92264cacbcac7/run_eval.py#L107).

Owning-boundary deterministic reproduction invokes the actual `initSession`,
`initLegacySession`, `prepareSessionCredentials` and realm parser with provider
and persistence edges replaced. Baseline: `Target URL must have an authentication
realm`, event order `create,close`. Same input/assertions after repair: PASS,
`create` only. The permanently registered real-Prisma fixture additionally
checks one ACTIVE blank logical row, no auth lookup/injection/retirement,
unchanged public API negatives, subsequent real HTTPS credential preparation,
and existing HTTPS/private-checkpoint controls. It does not claim a new live
browser outcome or new coverage of every resume/fingerprint path.

Validation on the final source: the registered `browser-session` blackbox domain
passed (1/1, run `1793127797-1118288-16671`), TypeScript `tsc --noEmit
--incremental false` passed, and the deterministic boundary reproduction passed.
The first blackbox attempt caught a new test expectation using a full hostname
instead of the existing eTLD+1 realm. The test mock now echoes the requested
realm and the assertion expects `example.test`; runtime hunks were unchanged
and the independent reviewer re-approved the exact final snapshot.

## Human feedback

The parent required cleanup/export receipts before the new repair, an unchanged
task, exact runtime grounding, registered red/green regression, a row-tagged R1a
branch, no deployment and no further paid run before coordination. Those limits
are retained. Freedom and unrelated resources are untouched.

The failed proof's canonical run JSON SHA256 is
`a0374eb7a2ec86a08cb33560aaa5477708b557f9f5246dfca6643c4a2ee3851f`.
Both `benchmark-cleanup-4b8ed0ab0d2e4cabae149c3186617f05.status` and
`local-stack-cleanup.status` report clean. Native provider cleanup was verified.
The final Hub bundle uploaded after an initial cloud-archive TimeoutError.
The dedicated evidence publisher correctly rejected recording validation:
the browser has no attached recording because initialization failed before any
browser action. The diagnostic
[durable FE](https://www.roselabs.ai/?agent-id=87c3aa9e-b718-4041-9594-4e2cd61f2bd8)
is not presented as recording-complete outcome proof.
The [final scorecard](https://boxes.dev/visuals/vis_cd8dedeb460e0149755b2922cc1e6363)
preserves failure and verified cleanup. Reported cost is 0 cents, but this is a
ledger observation, not proof of zero external provider billing.

Next outcome proof remains one unchanged local BU-074 on the integrated repair,
under parent coordination. Only if it passes may the separate k3 RCA proof
proceed. The original full cohort remains unproved; BU-002's R2 policy conflict
is outside this repair.

## Reusable lesson

A browser may legitimately start without a web origin. Separate neutral session
initialization from realm-specific credential preparation, then prepare the
actual destination through the existing navigation boundary.
