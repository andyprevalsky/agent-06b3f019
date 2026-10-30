---
id: 2026-10-30-it28-bu096-promoted-browser-reattach-unavailable
date: 2026-10-30
title: BU096 loses browser availability after Steel promotion
surface: agents
component: browser-provider-handoff
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: The promoted Steel session cannot complete either worker CDP attachment after a successful backend probe; handshake failure phase and initiating cause remain unknown
symptoms:
  - "BrowserStackUnavailableError"
  - "Reattach to promoted browser session failed; retrying once"
  - "connect() timed out after 15s"
tags:
  - it28
  - bu096
  - r119
  - cdp
  - provider-handoff
sources:
  - commit d0663f361a1118ce6776d1ab8aaa0987dcf252a5
  - agent 2f6098bb-00e8-48af-b0d3-8cd388f5da3f
  - plan:.context/r119/proof.json
repro: none-recorded
status: open
---

## Problem

All seven normal members verify against manifest b3744d21af3ad4dca876249843eb740bd1d3a551dea61a56926cd0a222da873b. Archive 7227de651d43853de923b605fda3da41a469589381d1663722303188c829deb1; source d0663f361a1118ce6776d1ab8aaa0987dcf252a5, patch none.

Native FAILED577.7s/progress1, canonicalFAILED, producerinfraFALSE. A correct two-object list schema asks first and last names for the two highest-scoring winning players; no captured completion/verifier invocation or declared semantic grade precedes the native failure.

## Diagnosis

Actual first chain: RealGM Document GET403 with Cloudflare HTML → runtime replaces actor evaluate with provider-exit recovery (worker8777,19:09:26.186418Z) → backend probes candidates, then promotes auth_kept/steel_fixed with stablePasses1/attempts1 (backend14799,19:12:39.112Z) → announces Steel session fbda8e55-fbfd-421f-a584-7c4c23d750e3 ACTIVE and returns200 → old Tilion socket closes1000 after promotion → worker native BrowserStart/connect fails15s twice on the new Steel endpoint → handles cleared → next guarded observation raises BrowserStackUnavailableError at13523,19:14:42.292024Z.

The two new-session connection failures are positive operational transport evidence, independently reported immediately. They do not determine vendor/local responsibility. The old close1000 is compatible with intentional handoff, not necessary to that operational finding. No recovered new-session connection is recorded before fatal.

Exact source inspection: handler _reconnect_browser_stack_after_rotation tears down old handles, opens the new connection, and preserves errors while cleaning failed handles. _retry_promoted_browser_reattach makes one existing delayed retry; it did run. Backend challengeRecoveryPromote updates the exact task binding transactionally, announces the new binding and releases the old provider session. challengeRecovery probe awaits its validation-CDP close attempt in finally before promotion; the helper suppresses close errors, so successful disposal is not established. No missing one-retry or missing backend probe-client close is established. Earlier Steel startup-error preservation and R88 connection-loss cases were read as comparators, not adopted as causes.

Two archive searches used the exact reattach/unavailable error and the provider-promotion/CDP-timeout behavior. Prior Steel startup-error preservation and R88 connection-loss Solution/Human feedback were read; a common outer error does not establish common cause.

### Probe and worker handoff comparison

The Steel factory creates a Playwright validation client for the candidate;
probeCandidateBrowser uses that same client and awaits the common
closeValidationBrowser helper before returning. The explicit second close at
promotion is Tilion-only. These facts reconcile the source accounts; neither
proves that a Steel socket actually closed, because the helper catches errors.
The remote browser session intentionally persists for the worker.

Backend promotion uses the same candidate session object by source, commits the
new task binding and releases the old provider before a worker acknowledgement.
The original clean-probe log does not include the winning session ID or
materialized CDP endpoint. The later ACTIVE binding and failed worker URL agree
on the Steel session ID, but do not independently prove the probe endpoint.

Backend and worker each add their own process STEEL_API_KEY to a public CDP URL
at connection time. The original worker endpoint's repeated unescaped-string
SHA is0b6b75356c01bd2c42588159c0be2be81c41ebe4955b81cb0e2c8a9bdb3437de;
its appearance in the later backend failure is a copy, not a second credential
sample. No original probe key/URL or full response body is present, so actual
credential equality or mismatch remains unknown. No current environment read
was substituted for historical evidence.

Source session lifetime is at least35min for ordinary positive settings, while
this candidate is created and lost inside a577.7s activity. Expiration is not
established; original provider create options and terminal reason are absent.
The exact handshake phase and remote transition remain the missing proof.

## Solution

No safe causal runtime change is grounded from the available originals. Native connect failure phase (DNS/TCP/TLS/WebSocket handshake/target initialization), the exact post-promotion remote state, and timing/ownership of the validated candidate's transition are not captured here. Increasing timeouts/retries, undoing the binding, retaining dead old handles, or replaying the model would not establish the cause. No such change or new call was made. All original grades remain immutable.

Mode scope: raw fastcache flag is true. Actual worker logs contain14 browser_use_write_only events,14 browser_use_stored,15 llm.cache entries and original schema+14 browser outputs. These observations do not claim full native/mode qualification or a cache-hit inference. Four demo_cache.set_error events remain distinct incidental diagnostics.

Normal cleanup independently records Steel200 receipt with root_deleted/tree_sealed and cleanup_failure null. It does not prove the earlier connection succeeded. Original task outcome and causal RCA remain OPEN. Parent owns operational stop and later release decisions; this worker issued no stop, query, recovery or provider operation.


No deterministic causal repair or original benchmark replay is claimed. No runtime change is proposed from a mocked success alone.

Coordinator operational instructions required prompt, separate reporting of
proven transport unavailability without assigning the initiating cause. This
worker was not delegated stop authority; the coordinator owns the campaign
stop and release decisions. These are investigation instructions, not direct
human feedback or changes to the original producer classification.

## Human feedback

The user prioritized native agent failures and progress0, including the actual
schema and validator/completion flow, while clarifying that this priority does
not exclude other failures. This case preserves the native failure separately
from schema correctness, progress1 and the unchanged producer classification.

## Reusable lesson

Separate a successful candidate probe and intentional old-session teardown from the later worker attachment failure; preserve both sides before assigning the handoff cause.
