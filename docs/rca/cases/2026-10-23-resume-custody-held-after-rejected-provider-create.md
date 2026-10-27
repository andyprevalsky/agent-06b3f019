---
id: 2026-10-23-resume-custody-held-after-rejected-provider-create
date: 2026-10-23
title: Browser resume custody stayed STARTED after the provider rejected its create, so every retry waited and failed "Browser resume is still in progress"
surface: back-end
component: browser-resume-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/lifecycleClaim.ts withBrowserResumeLifecycle left its browser_task_resume ToolSideEffect row STARTED (phase creating, nativeOutstanding) when deps.resume() failed on a definite provider create rejection (Kernel HTTP 400)
symptoms:
  - "Browser session init failed after 5 transient-proxy retries: {\"error\":\"Browser resume is still in progress\"}"
  - "{\"error\":\"Browser resume is still in progress\"}"
  - "Transient browser session init failure; retrying with a fresh proxy"
  - "BrowserResumeCustody: attempt 178/601 returned a retryable result"
  - browser-auth-assistance-declined Timeout after 902s (task timeout=900s)
tags:
  - browser
  - resume
  - custody
  - kernel
  - browser-use
  - idempotency
  - descend-full69-20261023
sources:
  - agent 4f3b90f3-f1d9-4436-9d1b-106cf89a2a5f
  - fleet run original600-1792722242636117810 shard-02 20261023-023933-27320 (r001-j0021, source cbbf3dd0c)
  - task browser-auth-assistance-declined
  - commit dedf0aba3 (introduced durable resume custody)
repro: back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts
status: open
---

## Problem

Benchmark task `browser-auth-assistance-declined` (descend run
descend-full69-20261023, copy r001-j0021, agent
`4f3b90f3-f1d9-4436-9d1b-106cf89a2a5f`) timed out at 902s; the root's
attempt_completion landed about 10s after the 900s limit. The final ~2.5
minutes were spent re-messaging the finished browser child (task
`cc360713-2529-56b4-9e66-0d8e139e326e`):

- 03:08:01.129 backend `Resuming browser task ... forceFreshProfile=false`,
  `Kernel browser creation requested`.
- 03:08:11.424 backend `Failed to init browser session error=Error: 400 Proxy
  health check failed ... proxyconnect tcp: EOF`, `POST /api/browser-session/init -> 500`.
- 03:08:46, 03:09:21, 03:09:56, 03:10:31 worker `Transient browser session init
  failure; retrying with a fresh proxy` with detail
  `{"error":"Browser resume is still in progress"}` (each ~35s: 30s custody
  wait + backoff), then `Browser session init failed after 5 transient-proxy
  retries`.

Retries 2-5 never reached the provider: the backend refused them while
waiting on the first attempt's custody row.

## Diagnosis

Critical path: worker `spawn_browser_agent_v3` session init -> `POST
/api/browser-session/init` -> `resumeBrowserSession` ->
`withBrowserResumeLifecycle` (durable `browser_task_resume` ToolSideEffect
row) -> `resumeKernelSession` -> `client.browsers.create`.

1. Attempt 1 claimed the row, `beforeCreate` set phase `creating`, and Kernel
   answered the create with HTTP 400. `deps.resume()` threw; nothing released
   the row, so it stayed STARTED with `expiresAt = now + steelSessionTimeoutMs()`
   (35+ minutes).
2. Attempts 2-5 found a STARTED, unexpired, compatible row and polled for
   `RESUME_WAIT_MS` (30s) before throwing `Browser resume is still in progress`.
3. Even after expiry, recovery would inspect the provider by marker, find no
   native browser (none was ever allocated) and throw `Browser resume create
   outcome remains unknown`, so the task stayed wedged.

Why was this possible (Step 5a)? The custody contract treats every failed
create as an uncertain outcome. That is right for timeouts, transport errors
and 5xx, which may still allocate a paid browser, but a provider's HTTP 4xx
(non-408) answer proves nothing was allocated. The sibling Steel claim
(`withSteelLifecycleClaim.runNative`) already settles on exactly that
classification; the resume custody added in dedf0aba3 never adopted it, and
the Browser Use client dropped the HTTP status from its errors, so the
distinction was not even observable there. The next "why" (custody must be
durable at all) is a deliberate design decision, so the ladder stops here.

Local repro: new `create-rejected` scenario in
`browser-session-resume-custody.cases.ts` (both providers): the fixture
provider returns 400 on the first create, then the test retries immediately
without expiring the ledger. On b84475d38 the retry hung in
`BrowserResumeCustody` polling (178 attempts) and the fixture timed out for
both browser-use and kernel.

## Solution

`lifecycleClaim.ts` now has one `nativeRequestRejected` classifier (HTTP 4xx
except 408) shared by the Steel claim and resume custody. Provider create
calls in `kernel.ts` and `resumeRecovery.ts` go through `resumeNativeCreate`,
which records a definite rejection in the resume scope. When `deps.resume()`
fails after a rejected create (phase `creating`), custody is released with
`response.phase = 'rejected'`, so the next resume claims and creates at once.
Uncertain outcomes keep durable custody unchanged. `browserUseClient.request`
now attaches `status` to its HTTP errors, like the Kernel and Steel SDKs.

10k-agent behavior: one extra conditional `updateMany` on the task's own
keyed row, only on a rejected create; no new shared state, polling or
fan-in. It removes up to 4 x 30s of per-task DB polling per rejected create.

Golden reference: openclaw/src/gateway/control-ui-public-session-admission.ts:221-227
coalesces in-flight work and always deletes the in-flight entry once the
operation settles, so followers never wait on a finished failure. Rose
converges for outcomes known to be settled (definite rejection) and keeps
durable custody only where a paid native allocation may still exist.

## Human feedback

None recorded.

## Reusable lesson

Release durable idempotency custody as soon as the provider definitively rejects the guarded request; only uncertain outcomes may keep followers waiting.
