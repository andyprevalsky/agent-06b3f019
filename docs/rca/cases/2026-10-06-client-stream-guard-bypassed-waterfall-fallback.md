---
id: 2026-10-06-client-stream-guard-bypassed-waterfall-fallback
date: 2026-10-06
title: Client stream guard terminated a metadata-only waterfall before its configured fallback
surface: agents
component: rose-waterfall-stream-guard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseClient wrapped the entire waterfall outside its per-model error handler, so its TTFT error could not enter the configured next leg
symptoms:
  - rose.complete.failed active_route waterfall error_type RoseStallError
  - rose.complete TTFT exceeded 90.0s
  - first metadata at 10.5 seconds with no productive chunks and no second waterfall step
tags:
  - cloud-fleet
  - waterfall
  - streaming
  - ttft
sources:
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
  - fleet run 20261006-205741-10814
  - plan:.context/trial2-waterfall-stall-rca/runtime-route-summary.safe.json
repro: agents/tests/blackbox/rose.blackbox.py:test_client_waterfall_stalled_leg_uses_existing_fallback
status: open
---

## Problem

The ordinary fifty-task DAILY LIVE trial recorded five terminal requests owned
by one browser root. Each used the browser-use pool and its existing two-leg
waterfall. Cerebras fell through in about 0.33 seconds. The first Qwen
OpenRouter leg yielded metadata near 10.5 seconds, then no productive normalized
chunks or buffered tool arguments. The whole request terminated with
RoseStallError after 90.33–90.42 seconds. No configured second leg was attempted.
Original worker bytes, request/span/root bindings, run artifact and database
cleanup roots are retained privately. The trial earns zero acceptance credit.

## Diagnosis

The client applied its existing progress/deadline guard to the entire waterfall.
The waterfall could catch errors raised by its transport/parser, but a guard
error raised outside that generator cancelled it before its existing per-model
handler could advance. This is a recoverability boundary defect. The existing
error taxonomy classifies pre-output TTFT stalls as fall-through errors and
whole-request deadlines as terminal. The owning fallback implementation already
refuses continuation after user-visible output.

Archive searches for streaming stall/waterfall/TTFT and metadata-only first
output identified the buffered-tool-progress, schema-wall-deadline and stalled
direct-compute-token cases. Their parser-progress and direct-route fixes concern
different boundaries; their evidence does not establish this occurrence's cause.
The error taxonomy and existing waterfall transport-failure controls provide
the local reference for the intended recovery contract.

The isolated owning reproduction runs the actual RoseClient, configured browser
pool, OpenRouter HTTPX transport and SSE parser with an explicit offline
MockTransport. The event loop stays real; only the existing client's wait proxy
advances virtual time. A first leg delivers headers after 10.5 seconds and then
remains silent. The unchanged 590/90/120-second budgets remain in effect. The
same registered controls on original c214 produce one failure and two passing
inverses; the repair passes all three. The stalled response closes before the
next configured model runs. This proves the owned fallback defect without
making paid model calls or changing inputs to an evaluator.

The upstream reason for the original silence remains unknown. Original browser
calls suppress the generic client dump and write their browser dump after a
successful collect. Eleven hash-verified dumps from the same original span
contain successful earlier browser steps, not the failed request's exact input
or original timed wire bytes. They cannot be substituted for that request. The
controlled timeout replay establishes the fallback mechanism; it does not
reproduce or explain the original serving endpoint, concurrency or prompt
condition. This case remains open pending independent review, deployment and
ordinary LIVE observation; provider-latency attribution remains an observability
gap even if the fallback repair succeeds.

## Solution

Pass the existing request guard into the waterfall and apply it inside each
existing leg's error boundary. A pre-output TTFT stall can then enter the already
configured next model. Preserve RoseDeadlineError as terminal regardless of
whether output has begun. Existing partial-output protection continues to
propagate errors rather than splice responses from different models. The fixed
whole-request deadline bounds every leg together; each leg retains its original
TTFT budget and cancellation/response closure. No timeout constant, pool, model,
prompt, tool, task or evaluator changes.

The three permanent owning controls cover recovery, whole590 expiry during a
later leg, and partial-output idle120 without fallback. Existing parser-progress
controls retain their actual per-attempt90 limits and verify aggregate failure
only after every configured leg fails. Existing mocked one-leg waterfalls use
the same guard contract; the new owning control does not mock the waterfall.
The ordinary deploy-owned Rose suite registers these controls, with Rose,
rose-browser-use and LLM functional/coverage checks on the final source.
Private source/test hashes, unchanged RED/GREEN logs and native process closure
receipts live under `.context/trial2-waterfall-stall-rca/`.

At 10,000 concurrent agents this adds no channel, polling loop, shared lock or
new timer. It moves one existing guard to the currently active configured leg.
Only an already-authorized fallback that the old guard incorrectly skipped can
make an additional provider attempt, still under the original fixed deadline.
Actual final qualification and independent review must be recorded before
marking this repair deployed or granting any fleet credit.

## Failure-capture addendum

Independent review confirmed the guarded-fallback repair while retaining the
missing failed-input gap. The RCA methodology explicitly says to add missing
capture and keep the RCA open. The narrow browser collect failure boundary now
uses the existing best-effort context dumper with the same built message/tool
inputs, initial requested generation/deadline/cache controls and a request ID
bound before collection. The dumper retains its existing span, agent and root
binding, storage, encryption and production size controls. Unknown actual model,
mode and response remain unknown; no synthetic response or inferred successful
output is written. The requested omitted effort and known pool waterfall effort
are separate, so capture does not invent an effective provider route.

An ordinary collect exception is re-raised as the same object even if capture
fails. Cancellation is not caught and starts no capture. The normal successful
browser dump remains unchanged; enabling a second generic success dump would
repeat large contexts unnecessarily. No new channel, provider attempt, public
provider interface, timeout, grading gate or source-policy phase is added. At
10,000 requests the success path adds only request-ID binding previously done in
the inner client; failure serialization runs once through the existing helper.

The new permanent controls execute the actual production browser method with a
controlled failure at its normal collect boundary, then inspect the real dump
in an isolated private directory. They verify original request/span/root,
messages/tools, requested configuration and cache association, unknown response
fields, exception identity, capture-failure behavior and cancellation. The
unchanged successful Cerebras dump control remains in the same owning command.
The frozen guard candidate is the RED baseline for this addendum, rather than
substituting the original unguarded client. Setup/import and invalid synthetic
history-shape attempts were excluded; the valid identical four-control pair
produced two FAIL/two PASS before capture and four PASS afterward. Their exact
hashes, native owners, timestamps and normal browser-family receipt are retained
under `.context/trial2-waterfall-stall-rca/failure-capture-*.safe.json`.

This captures future browser-call ingress and its requested controls; it does
not claim original timed wire bytes, effective per-retry parameters, or a lost
original input. The eleven earlier successful dumps remain non-substitutable,
and the original provider-silence/concurrency question remains open. Instrumenting
the next occurrence does not grant LIVE acceptance or turn this RCA into a
completed upstream attribution.

## Human feedback

Keep task failures acceptable, preserve runtime integrity, use generous whole
stage boundaries and avoid artificial calls or narrowly tuned assertions.
Continue through the ordinary CLI and cement focused regressions in deploy.
Do not alter task grading or claim that synthetic evidence resolves an original
LIVE failure or establishes a provider-concurrency cause.

## Reusable lesson

Place a recoverable per-attempt stream guard inside the owner of configured fallback while keeping global deadlines and partial-output errors terminal.
